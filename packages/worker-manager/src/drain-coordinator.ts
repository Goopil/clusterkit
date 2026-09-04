import type { Worker } from "node:cluster";
import type { Logger, ResolvedConfig, WorkerMetrics } from "./types";

/**
 * Drains replaced workers in a bounded way: notify via IPC, disconnect, then
 * escalate SIGTERM → SIGKILL if the worker does not exit on its own.
 * Used by age-based recycling (via Orchestrator.handleWorkerRecycle) and by
 * hot restarts (restartWorkers → awaitBoundedWorkerExit).
 */
export class DrainCoordinator {
  private readonly cfg: ResolvedConfig;
  private readonly log: Logger | null;
  private readonly metrics: WorkerMetrics;
  private readonly isShuttingDown: () => boolean;
  private readonly shutdownType: string;

  constructor(
    cfg: ResolvedConfig,
    log: Logger | null,
    metrics: WorkerMetrics,
    deps: { isShuttingDown: () => boolean },
  ) {
    this.cfg = cfg;
    this.log = log;
    this.metrics = metrics;
    this.isShuttingDown = deps.isShuttingDown;
    this.shutdownType = `${cfg.shutdown.messagePrefix}:shutdown`;
  }

  /**
   * Budget for a recycled/replaced worker to exit on its own: the full
   * shutdown escalation window (graceful timeout + signal delays) plus a
   * margin, after which it is force-killed.
   */
  private get workerDrainBudgetMs(): number {
    return this.cfg.shutdown.timeoutMs + this.cfg.shutdown.sigtermDelayMs + this.cfg.shutdown.sigintDelayMs + 5_000;
  }

  /**
   * Drain orchestration for a replaced worker: watch the replacement's
   * "online" (drain the old worker) and "exit" (replacement died at boot —
   * drain anyway) events, with a bounded failsafe for a replacement that
   * never reaches either.
   */
  recycle(oldWorker: Worker, newWorker: Worker): void {
    // If the replacement dies before coming online (OOM at boot, invalid
    // flag...), the online handler below never runs and the old worker would
    // linger undrained — drain it instead so the recycle still completes.
    let replacementOnline = false;
    let drained = false;
    const drainOldWorker = (): void => {
      if (drained) return;
      drained = true;
      clearTimeout(drainFailsafeTimer);
      this.drainRecycledWorker(oldWorker);
    };

    newWorker.once("exit", () => {
      if (drained || replacementOnline || this.isShuttingDown()) return;
      this.log?.warn("Replacement died before online, draining old worker", { workerId: oldWorker.id });
      drainOldWorker();
    });

    // Disconnect old worker after new one is online
    newWorker.once("online", () => {
      replacementOnline = true;
      if (this.isShuttingDown()) return;
      drainOldWorker();
    });

    // Failsafe: the drain trigger fires only on the replacement's "online" or
    // "exit" event — a replacement that is forked but stuck before "online"
    // (boot hang) and never exits would leave the old worker undrained
    // forever. Drain it anyway once the same bounded budget as
    // awaitBoundedWorkerExit expires.
    const drainFailsafeTimer = setTimeout(() => {
      if (replacementOnline || this.isShuttingDown() || oldWorker.isDead()) return;
      this.log?.warn("Replacement did not come online in time, draining old worker anyway", {
        workerId: oldWorker.id,
        newWorkerId: newWorker.id,
      });
      drainOldWorker();
    }, this.workerDrainBudgetMs);
    drainFailsafeTimer.unref();
  }

  /**
   * Wait for a recycled worker to exit during a hot restart, with a bounded
   * wait: if the worker outlives the total shutdown budget (graceful timeout
   * + signal delays) plus a margin, force-kill it so the rolling restart
   * cannot deadlock on an "exit" event that never arrives (e.g. replacement
   * never came online and the drain escalation in `recycle` never armed).
   *
   * Implemented with an explicit setTimeout race instead of
   * `once(worker, "exit", { signal: AbortSignal.timeout(ms) })` because
   * AbortSignal.timeout is backed by native timers that never fire under
   * vitest fake timers.
   */
  async awaitBoundedWorkerExit(worker: Worker): Promise<void> {
    // The worker may have died between the snapshot and this call: its "exit"
    // event already fired, so waiting for it would stall for the full budget.
    if (worker.isDead()) return;

    const exitWaitMs = this.workerDrainBudgetMs;

    await new Promise<void>((resolve) => {
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;

      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(waitTimer);
        if (graceTimer) clearTimeout(graceTimer);
        worker.removeListener("exit", onExit);
        worker.removeListener("exit", onGracePeriodExit);
        resolve();
      };

      const onExit = () => settle();
      const onGracePeriodExit = () => settle();

      const waitTimer = setTimeout(() => {
        this.log?.warn("Old worker did not exit in time during restart, forcing kill", {
          workerId: worker.id,
          pid: worker.process.pid ?? 0,
        });
        try {
          if (!worker.isDead()) {
            worker.process.kill("SIGKILL");
            this.metrics.forcedKills++;
          }
        } catch {
          /* already dead */
        }
        // Best-effort: give the force-killed worker a short grace period to
        // emit "exit" before moving on to the next worker in the roll.
        graceTimer = setTimeout(settle, 2_000);
        graceTimer.unref();
        worker.once("exit", onGracePeriodExit);
      }, exitWaitMs);
      waitTimer.unref();

      worker.once("exit", onExit);
    });
  }

  /**
   * Drain a recycled worker: request shutdown, disconnect, then escalate to
   * SIGTERM and SIGKILL if the worker does not exit on its own.
   */
  private drainRecycledWorker(oldWorker: Worker): void {
    // A worker can exit concurrently with the drain: its IPC write then fails
    // with 'write EPIPE'/'channel closed', which Node surfaces as an ASYNC
    // 'error' event on worker.process (child_process._send) — after the sync
    // try/catch below has passed, and fatal to the primary without a
    // listener. Route send errors to a no-op callback (Worker.send delegates
    // to process.send, which routes send errors to a callback when given)
    // and keep a no-op 'error' listener on the process for the worker's
    // remaining lifetime: disconnect()'s internal send accepts no callback,
    // so its failure can only be absorbed by the listener (same pattern as
    // ShutdownCoordinator.initiateShutdown).
    const swallowError = (): void => {};
    oldWorker.process.on("error", swallowError);

    try {
      oldWorker.send({ type: this.shutdownType }, swallowError);
      if (!oldWorker.isDead()) oldWorker.disconnect();
    } catch {
      /* worker already dead */
    }

    if (oldWorker.isDead()) return;

    // Escalate on the same budget as a coordinated shutdown: the worker keeps
    // its full graceful window (shutdown.timeoutMs) before SIGTERM, then the
    // same SIGTERM→SIGINT→SIGKILL escalation window (sigtermDelayMs +
    // sigintDelayMs) before SIGKILL — matching what
    // ShutdownCoordinator.killWorkerGradually would spend on it.
    // Calling disconnect() again is a no-op on an already-disconnected
    // worker, so we must escalate to signals to prevent a stuck worker
    // from leaking.
    //
    // The sigkillTimer's exit listener is registered inside the
    // forceKillTimer callback — so if the worker exits after SIGTERM
    // (before the SIGKILL window), the timer is cleared. Both
    // listeners use once(), so no listener accumulation across recycles.
    const forceKillTimer = setTimeout(() => {
      if (!oldWorker.isDead() && !this.isShuttingDown()) {
        try {
          oldWorker.process.kill("SIGTERM");
        } catch {
          /* already dead */
        }
        const sigkillTimer = setTimeout(() => {
          if (!oldWorker.isDead() && !this.isShuttingDown()) {
            try {
              oldWorker.process.kill("SIGKILL");
              this.metrics.forcedKills++;
            } catch {
              /* already dead */
            }
          }
        }, this.cfg.shutdown.sigtermDelayMs + this.cfg.shutdown.sigintDelayMs);
        sigkillTimer.unref();
        oldWorker.once("exit", () => clearTimeout(sigkillTimer));
      }
    }, this.cfg.shutdown.timeoutMs);
    forceKillTimer.unref();
    oldWorker.once("exit", () => clearTimeout(forceKillTimer));
  }
}
