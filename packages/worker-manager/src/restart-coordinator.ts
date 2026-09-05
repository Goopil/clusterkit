import type { Worker } from "node:cluster";
import type { CrashTracker } from "./crash-tracker";
import type { Logger, ResolvedConfig, WorkerMetrics } from "./types";

/**
 * Consecutive fork failures (EMFILE/ENOMEM...) tolerated before the restart
 * machinery declares the environment unrecoverable and stops retrying.
 */
export const MAX_CONSECUTIVE_FORK_FAILURES = 3;

/**
 * A pending restart: either the restart of a crashed worker, or a capacity
 * refill queued after resetCircuitBreaker() (no worker actually crashed).
 */
export type RestartQueueEntry =
  | { kind: "refill" }
  | { kind: "crash"; workerId: number; code: number | null; signal: string | null };

/** Dependencies injected by the Orchestrator. */
export interface RestartCoordinatorDeps {
  /** Fork a replacement worker (WorkerManager.forkWorker). */
  forkWorker: () => Worker;
  /** True while a graceful shutdown is in progress. */
  isShuttingDown: () => boolean;
  /** Resolved worker count target. */
  targetWorkerCount: () => number;
  /** Workers marked for recycling — still alive but already replaced. */
  recyclingCount: () => number;
  /** Called after a replacement was forked (Orchestrator emits worker:restart). */
  onRestarted: (newWorker: Worker) => void;
  /** Called when the breaker trips (Orchestrator flips readiness and emits circuit-breaker:tripped). */
  onBreakerTripped: (info: { crashCount: number; windowMs: number }) => void;
  /** True while at least one worker serves: boot-failure quarantine only arms while the rest of the fleet is up. */
  hasOnlineWorkers: () => boolean;
  /** Called when a slot is quarantined (Orchestrator emits worker:quarantined). */
  onQuarantined: (info: { consecutiveBootFailures: number }) => void;
}

/**
 * Owns the crash-restart machinery: restart queue, exponential backoff,
 * fork-failure accounting, and circuit-breaker reactions.
 *
 * Failure protocol (process.exitCode = 1): written here on an empty fleet, a
 * breaker trip, or an unrecoverable fork environment. Recovery (exitCode = 0,
 * health.ready = true) is owned by the Orchestrator.
 */
export class RestartCoordinator {
  private readonly cfg: ResolvedConfig;
  private readonly log: Logger | null;
  private readonly metrics: WorkerMetrics;
  private readonly crashTracker: CrashTracker;
  private readonly deps: RestartCoordinatorDeps;

  // Restart queue state
  private restartLoopRunning = false;
  private pendingRestartQueue: RestartQueueEntry[] = [];

  // Exponential backoff for worker restarts
  private restartBackoffDelay = 0;
  private backoffResetTimer?: NodeJS.Timeout;

  // Consecutive forkWorker() failures — reset on any successful fork
  private consecutiveForkFailures = 0;

  // Boot-loop quarantine: consecutive crashes of workers that never came online
  private consecutiveBootFailures = 0;
  private quarantinedSlots = 0;

  // One process warning per breaker trip
  private breakerWarningEmitted = false;

  constructor(
    cfg: ResolvedConfig,
    log: Logger | null,
    metrics: WorkerMetrics,
    crashTracker: CrashTracker,
    deps: RestartCoordinatorDeps,
  ) {
    this.cfg = cfg;
    this.log = log;
    this.metrics = metrics;
    this.crashTracker = crashTracker;
    this.deps = deps;
  }

  /**
   * A worker crashed (unclean exit): record the crash, react to a possible
   * breaker trip, otherwise queue a restart and kick the loop.
   *
   * A boot failure (`bootFailed`: the worker exited without ever coming
   * online) quarantines its slot after `restart.bootFailQuarantine`
   * consecutive failures while the rest of the fleet serves.
   */
  onWorkerCrash(workerId: number, code: number | null, signal: string | null, bootFailed = false): void {
    const quarantine = this.cfg.restart.bootFailQuarantine;
    if (bootFailed && quarantine > 0 && this.deps.hasOnlineWorkers()) {
      this.consecutiveBootFailures++;
      if (this.consecutiveBootFailures >= quarantine) {
        this.quarantinedSlots++;
        this.log?.warn("Boot-loop detected — quarantining slot (no re-fork)", {
          workerId,
          consecutiveBootFailures: this.consecutiveBootFailures,
        });
        this.deps.onQuarantined({ consecutiveBootFailures: this.consecutiveBootFailures });
        // Deliberately no crash record and no restart: one bad slot must not
        // poison the fleet breaker or burn forks. Remedy: restartWorkers().
        return;
      }
      // Pre-quarantine boot failure: a real crash — fall through to the
      // record + restart path below.
    }

    // ALWAYS record, even if restart is locked
    this.crashTracker.record();

    // An empty fleet cannot recover on its own once the event loop drains
    // (all restart/backoff timers are unref'd): flag a failure exit code so
    // supervisors do not read the death of the primary as a clean stop.
    // Cleared when capacity is restored (Orchestrator.handleWorkerOnline).
    if (this.metrics.activeWorkers === 0) {
      process.exitCode = 1;
    }

    if (this.crashTracker.isTripped()) {
      const tripInfo = { crashCount: this.crashTracker.count, windowMs: this.cfg.restart.crashWindowMs };
      this.log?.error("Crash loop detected — stopping restarts", tripInfo);
      // A tripped breaker self-terminates the primary once the fleet drains,
      // and exit 0 would mask the crash. Cleared by resetCircuitBreaker() or
      // restored capacity (Orchestrator.handleWorkerOnline).
      process.exitCode = 1;
      // The default logger is null: without this, a minimal setup loses
      // restart capacity with zero output. One warning per trip.
      if (!this.breakerWarningEmitted) {
        this.breakerWarningEmitted = true;
        process.emitWarning(
          "Crash loop detected — stopping worker restarts. Fix the cause, then call resetCircuitBreaker() to re-arm.",
          "ClusterKitCrashLoop",
        );
      }
      this.deps.onBreakerTripped(tripInfo);
      this.metrics.crashLoopBackoffs++;
      return;
    }

    // Breaker no longer tripped (reset or window slid) — a future trip warns again
    this.breakerWarningEmitted = false;

    // Queue restart and process asynchronously
    this.pendingRestartQueue.push({ kind: "crash", workerId, code, signal });
    this.kickRestartQueue();
  }

  /** A replacement came online: any successful boot resets the boot-failure streak. */
  onWorkerOnline(workerId: number): void {
    this.consecutiveBootFailures = 0;

    // Reset backoff only after a sustained crash-free window
    if (this.restartBackoffDelay > 0) {
      this.scheduleBackoffReset(workerId);
    }
  }

  /** A non-graceful exit breaks stability and cancels a pending backoff reset. */
  cancelBackoffReset(): void {
    clearTimeout(this.backoffResetTimer);
    this.backoffResetTimer = undefined;
  }

  /** Reset engine state (tracker, backoff, fork-failure counter). */
  reset(): void {
    this.crashTracker.reset();
    this.restartBackoffDelay = 0;
    this.consecutiveForkFailures = 0;
  }

  /** Number of slots currently quarantined by the boot-loop guard. */
  getQuarantinedCount(): number {
    return this.quarantinedSlots;
  }

  /** Clear quarantine state — a restartWorkers() roll re-forks every slot. */
  resetQuarantine(): void {
    this.quarantinedSlots = 0;
    this.consecutiveBootFailures = 0;
  }

  /**
   * Queue `count` capacity refills (after the Orchestrator accepted a breaker
   * reset and knows the fleet had already forked).
   */
  requestCapacityRefill(count: number): void {
    for (let i = 0; i < count; i++) {
      this.pendingRestartQueue.push({ kind: "refill" });
    }
    this.kickRestartQueue();
  }

  /** Record a fork failure (EMFILE/ENOMEM...). Returns the consecutive failure count. */
  noteForkFailure(): number {
    return ++this.consecutiveForkFailures;
  }

  /** Record a successful fork: resets the consecutive failure counter. */
  noteForkSuccess(): void {
    this.consecutiveForkFailures = 0;
  }

  /** True once the fork environment is declared unrecoverable. */
  isForkEnvUnrecoverable(): boolean {
    return this.consecutiveForkFailures >= MAX_CONSECUTIVE_FORK_FAILURES;
  }

  private scheduleBackoffReset(workerId: number): void {
    if (this.cfg.restart.stabilityWindowMs === 0) {
      this.restartBackoffDelay = 0;
      this.log?.info("Worker start successful, reset restart backoff", {
        workerId,
        stabilityWindowMs: 0,
      });
      return;
    }

    clearTimeout(this.backoffResetTimer);

    this.backoffResetTimer = setTimeout(() => {
      this.backoffResetTimer = undefined;

      if (this.deps.isShuttingDown() || this.restartBackoffDelay === 0) {
        return;
      }

      this.restartBackoffDelay = 0;
      this.log?.info("Cluster remained stable, reset restart backoff", {
        stabilityWindowMs: this.cfg.restart.stabilityWindowMs,
      });
    }, this.cfg.restart.stabilityWindowMs).unref();
  }

  private kickRestartQueue(): void {
    this.processRestartQueue().catch((err) => {
      this.log?.error("Restart queue processing failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async processRestartQueue(): Promise<void> {
    if (this.restartLoopRunning) return;
    this.restartLoopRunning = true;

    try {
      while (this.pendingRestartQueue.length > 0) {
        if (this.deps.isShuttingDown()) {
          this.pendingRestartQueue = [];
          return;
        }

        // A tripped breaker stops all forks: queued entries are dropped —
        // resetCircuitBreaker() refills the missing capacity after the reset.
        if (this.crashTracker.isTripped()) {
          this.pendingRestartQueue = [];
          return;
        }

        const entry = this.pendingRestartQueue.shift();
        if (!entry) return;

        // Workers being recycled are still alive but already have a replacement
        // (or are about to exit) — exclude them so a crash overlapping a recycle
        // is not silently dropped, leaving the cluster under capacity.
        const targetWorkers = this.deps.targetWorkerCount();
        const settledWorkers = this.metrics.activeWorkers - this.deps.recyclingCount();
        const missingWorkers = Math.max(0, targetWorkers - settledWorkers);
        if (missingWorkers === 0) {
          continue;
        }

        await this.restartWorkerWithBackoff(entry);
      }
    } finally {
      this.restartLoopRunning = false;

      if (this.pendingRestartQueue.length > 0 && !this.deps.isShuttingDown()) {
        this.kickRestartQueue();
      }
    }
  }

  private async restartWorkerWithBackoff(entry: RestartQueueEntry): Promise<void> {
    const crashedWorkerId = entry.kind === "crash" ? entry.workerId : undefined;

    const delayMs = this.restartBackoffDelay > 0 ? this.restartBackoffDelay : this.cfg.restart.backoffMs;

    if (delayMs > 0) {
      this.log?.info("Waiting before restart", { delayMs, workerId: crashedWorkerId });
      await new Promise((resolve) => setTimeout(resolve, delayMs).unref());

      // Double check shutdown hasn't started during wait
      if (this.deps.isShuttingDown()) {
        this.log?.info("Shutdown started during backoff, aborting restart", { workerId: crashedWorkerId });
        return;
      }
    }

    // Fork-time breaker check: a trip between queueing and forking must not
    // leak a fork past the breaker. resetCircuitBreaker() refills the missing
    // capacity after the operator reset.
    if (this.crashTracker.isTripped()) {
      return;
    }

    if (entry.kind === "crash") {
      this.log?.warn("Worker crashed, restarting", {
        workerId: entry.workerId,
        code: entry.code,
        signal: entry.signal,
      });
    } else {
      this.log?.info("Refilling capacity after circuit breaker reset");
    }

    let newWorker: Worker;
    try {
      newWorker = this.deps.forkWorker();
    } catch (err) {
      // A fork failure (EMFILE/ENOMEM...) must not permanently shrink the
      // fleet: re-queue the entry so it is retried through the normal backoff.
      this.consecutiveForkFailures++;
      this.log?.error("Worker fork failed — restart re-queued", {
        attempt: this.consecutiveForkFailures,
        maxAttempts: MAX_CONSECUTIVE_FORK_FAILURES,
        error: err instanceof Error ? err.message : String(err),
      });
      if (this.consecutiveForkFailures >= MAX_CONSECUTIVE_FORK_FAILURES) {
        // Unrecoverable fork environment: flag a failure exit code (same
        // protocol as a breaker trip) and stop retrying.
        this.log?.error("Fork failing repeatedly — giving up on pending restarts", {
          maxAttempts: MAX_CONSECUTIVE_FORK_FAILURES,
        });
        process.exitCode = 1;
        this.pendingRestartQueue.length = 0;
        return;
      }
      this.pendingRestartQueue.push(entry);
      return;
    }
    this.consecutiveForkFailures = 0;

    this.metrics.workerRestarts++;
    this.deps.onRestarted(newWorker);

    // Increase backoff for next restart
    // First restart: use initial delay, others: multiply by factor
    const nextDelay = delayMs > 0 ? delayMs * this.cfg.restart.backoffMultiplier : this.cfg.restart.backoffMs;
    this.restartBackoffDelay = Math.min(nextDelay, this.cfg.restart.maxBackoffMs);
  }
}
