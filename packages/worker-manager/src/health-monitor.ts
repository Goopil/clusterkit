import type { Logger, ResolvedConfig, WorkerHealthReport } from "./types";
import { isTypedMessage } from "./types";

export type RecycleTrigger = "rss" | "wedged";

export interface HealthMonitorDeps {
  isShuttingDown: () => boolean;
  recycleWorker: (workerId: number, reason: RecycleTrigger) => void;
  onHealthReport: (report: WorkerHealthReport) => void;
  onWedged: (info: { workerId: number; pid: number; silentMs: number }) => void;
}

/**
 * Worker health heartbeat and primary-side policies (RSS recycle, wedged kill).
 * Worker side: periodic report over IPC (RSS, heap, event-loop beat drift).
 * Primary side: per-worker registry feeding the opt-in policies.
 * Pure plumbing: every observable outcome is delegated to the Orchestrator via deps.
 */
export class HealthMonitor {
  private readonly cfg: ResolvedConfig;
  private readonly log: Logger | null;
  private readonly deps: HealthMonitorDeps;
  private readonly registry = new Map<number, { pid: number; lastReport: number; report: WorkerHealthReport }>();
  private readonly rssRecycled = new Set<number>();
  private readonly exitedWorkerIds = new Set<number>();
  private reportTimer?: NodeJS.Timeout;
  private wedgedTimer?: NodeJS.Timeout;
  private lastBeat = 0;

  constructor(cfg: ResolvedConfig, log: Logger | null, deps: HealthMonitorDeps) {
    this.cfg = cfg;
    this.log = log;
    this.deps = deps;
  }

  // ---- Worker side ---------------------------------------------------------

  /** Start periodic health reports over IPC. No-op when heartbeat is disabled. */
  startWorkerReporting(): void {
    const interval = this.cfg.health.heartbeatMs;
    if (interval <= 0) return;
    if (typeof process.send !== "function") return; // not a cluster worker
    this.lastBeat = Date.now();
    const type = `${this.cfg.shutdown.messagePrefix}:hb`;
    this.reportTimer = setInterval(() => {
      const now = Date.now();
      // Beat drift = how late this beat fired = event-loop stall indicator.
      const lag = Math.max(0, Math.round(now - this.lastBeat - interval));
      this.lastBeat = now;
      const { rss, heapUsed } = process.memoryUsage();
      try {
        process.send?.({ type, rss, heapUsed, eventLoopLagMs: lag });
      } catch {
        /* IPC channel closed (drain) — reporting is best-effort */
      }
    }, interval);
    this.reportTimer.unref();
  }

  stopWorkerReporting(): void {
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = undefined;
  }

  // ---- Primary side --------------------------------------------------------

  /** Route an IPC message; only health reports are consumed. */
  onWorkerMessage(workerId: number, pid: number, msg: unknown): void {
    if (!isTypedMessage(msg, `${this.cfg.shutdown.messagePrefix}:hb`)) return;
    if (this.exitedWorkerIds.has(workerId)) return; // slot drained — stale reports are dropped
    const m = msg as Record<string, unknown>;
    const { rss, heapUsed, eventLoopLagMs } = m as Record<string, number>;
    if (typeof rss !== "number" || typeof heapUsed !== "number" || typeof eventLoopLagMs !== "number") return;
    const report: WorkerHealthReport = { workerId, pid, rss, heapUsed, eventLoopLagMs };
    this.registry.set(workerId, { pid, lastReport: Date.now(), report });
    this.deps.onHealthReport(report);
    this.checkRssLimit(workerId, report);
  }

  private checkRssLimit(workerId: number, report: WorkerHealthReport): void {
    const limitMb = this.cfg.workers.maxRssMb;
    if (limitMb <= 0 || this.deps.isShuttingDown()) return;
    if (this.rssRecycled.has(workerId)) return; // one-shot per worker instance
    if (report.rss <= limitMb * 1024 * 1024) return;
    this.rssRecycled.add(workerId);
    this.log?.warn("Worker exceeded RSS limit, recycling", {
      workerId,
      rssMb: Math.round(report.rss / 1048576),
      maxRssMb: limitMb,
    });
    this.deps.recycleWorker(workerId, "rss");
  }

  /** Primary-side watch for wedged workers. Only workers that reported at least
   * once are eligible (a worker that never reported may simply be slow to boot). */
  startWedgedWatch(): void {
    const timeoutMs = this.cfg.health.wedgedTimeoutMs;
    if (timeoutMs <= 0) return;
    this.wedgedTimer = setInterval(() => {
      if (this.deps.isShuttingDown()) return;
      const now = Date.now();
      for (const [workerId, entry] of this.registry) {
        const silentMs = now - entry.lastReport;
        if (silentMs <= timeoutMs) continue;
        this.registry.delete(workerId); // fire once — the recycle owns the rest
        this.log?.warn("Worker heartbeat silent, draining it as wedged", { workerId, silentMs });
        this.deps.onWedged({ workerId, pid: entry.pid, silentMs });
        this.deps.recycleWorker(workerId, "wedged");
      }
    }, this.cfg.health.heartbeatMs).unref();
  }

  onWorkerExit(workerId: number): void {
    this.exitedWorkerIds.add(workerId);
    this.registry.delete(workerId);
    this.rssRecycled.delete(workerId);
  }

  stop(): void {
    this.stopWorkerReporting();
    if (this.wedgedTimer) clearInterval(this.wedgedTimer);
    this.wedgedTimer = undefined;
    this.registry.clear();
    this.rssRecycled.clear();
    this.exitedWorkerIds.clear();
  }
}
