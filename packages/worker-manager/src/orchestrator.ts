import cluster, { type Worker } from "node:cluster";
import { EventEmitter } from "node:events";
import { CrashTracker } from "./crash-tracker";
import { withLoggerPrefix } from "./logger";
import { getPlatformCapabilities, getReusePortCached, type PlatformCapabilities } from "./platform";
import { ShutdownCoordinator } from "./shutdown-coordinator";
import { SignalHandler } from "./signal-handler";
import { getCPUCount } from "./sizing";
import {
  type HealthStatus,
  isTypedMessage,
  type Logger,
  type OrchestratorConfig,
  type OrchestratorEvents,
  type OrchestratorPlugin,
  type ResolvedConfig,
  type WorkerMetrics,
} from "./types";
import { validateConfig } from "./validation";
import { WorkerManager } from "./worker-manager";

/** Upper bound applied to WEB_CONCURRENCY to guard against fork bombs from inherited env vars. */
const MAX_AUTO_WORKERS = 256;

/**
 * Main orchestrator that coordinates worker lifecycle, shutdown, and health.
 * Delegates specific concerns to specialized services:
 * - WorkerManager: fork, tracking, recycling
 * - ShutdownCoordinator: graceful shutdown sequence
 * - SignalHandler: POSIX signal management
 */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private readonly cfg: ResolvedConfig;
  private readonly baseLog: Logger | null;
  private readonly log: Logger | null;
  private readonly plugins: OrchestratorPlugin[] = [];

  // Services
  private readonly workerManager: WorkerManager;
  private readonly shutdownCoordinator: ShutdownCoordinator;
  private readonly signalHandler: SignalHandler;

  // IPC message types
  private readonly shutdownType: string;
  private readonly shutdownAckType: string;

  // Cluster module reference (injectable for tests)
  private readonly clusterRef: typeof cluster;

  // Application-level shutdown callbacks
  private readonly shutdownCallbacks: Array<(signal: string) => void | Promise<void>> = [];

  // State
  private isPrimaryStarted = false;
  private isWorkerStarted = false;
  private hasForked = false;
  private localShutdownInProgress = false;
  private cachedAutoWorkerCount?: number;

  // Metrics
  private readonly metrics: WorkerMetrics = {
    workerRestarts: 0,
    activeWorkers: 0,
    crashLoopBackoffs: 0,
    gracefulShutdowns: 0,
    forcedKills: 0,
  };

  // Health
  private readonly health: HealthStatus = { ready: true, live: true };

  // Circuit breaker
  private readonly crashTracker: CrashTracker;

  // Intervals
  private crashCleanupInterval?: NodeJS.Timeout;
  private backoffResetTimer?: NodeJS.Timeout;

  // Restart queue state
  private restartLoopRunning = false;
  private pendingRestartQueue: Array<{ workerId: number; code: number | null; signal: string | null }> = [];

  // Exponential backoff for worker restarts
  private restartBackoffDelay = 0;

  constructor(config: OrchestratorConfig = {}) {
    super();
    this.cfg = validateConfig(config);
    this.baseLog = this.cfg.logger ?? null;
    this.log = withLoggerPrefix(this.baseLog, "clusterkit:orchestrator");
    this.clusterRef = this.cfg.clusterModule ?? cluster;
    this.shutdownType = `${this.cfg.shutdown.messagePrefix}:shutdown`;
    this.shutdownAckType = `${this.cfg.shutdown.messagePrefix}:shutdown-ack`;
    this.crashTracker = new CrashTracker(this.cfg.restart.crashThreshold, this.cfg.restart.crashWindowMs);

    // Initialize services
    this.workerManager = new WorkerManager(
      this.clusterRef,
      this.cfg,
      withLoggerPrefix(this.baseLog, "clusterkit:worker-manager"),
      this.metrics,
      [...(this.clusterRef?.settings?.execArgv ?? process.execArgv)],
    );

    this.shutdownCoordinator = new ShutdownCoordinator(
      this.cfg,
      withLoggerPrefix(this.baseLog, "clusterkit:shutdown-coordinator"),
      this.metrics,
      this.cfg.shutdown.messagePrefix,
    );

    this.signalHandler = new SignalHandler();

    // Wire up service callbacks
    this.workerManager.setupEventHandlers(
      (worker) => this.handleWorkerOnline(worker),
      (worker, code, signal) => this.handleWorkerExit(worker, code, signal),
    );

    this.shutdownCoordinator.setupCallbacks(
      (signal) => this.handleShutdownStart(signal),
      (metrics) => this.handleShutdownComplete(metrics),
    );
  }

  // ============================================================================
  // Static platform helpers
  // ============================================================================

  static async supportsReusePort(): Promise<boolean> {
    const cached = getReusePortCached();
    if (cached !== undefined) {
      return cached;
    }
    // If not cached yet, return the synchronous check result
    return getPlatformCapabilities().then((caps) => caps.reusePort);
  }

  static async getCapabilities(): Promise<PlatformCapabilities> {
    return getPlatformCapabilities();
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Start the orchestrator.
   * In primary: forks workers.
   * In worker: starts the application.
   */
  async run(start?: () => Promise<void> | void): Promise<void> {
    if (this.clusterRef.isPrimary) {
      await this.runPrimary(start);
      return;
    }

    await this.runWorker(start);
  }

  private assertPrimaryCanRun(): void {
    if (this.isPrimaryStarted) {
      throw new Error("run() already called on this Orchestrator instance");
    }
  }

  private assertWorkerCanRun(): void {
    if (this.isWorkerStarted) {
      throw new Error("run() already called on this worker instance");
    }
  }

  private async installPlugins(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.install(this, this.baseLog, this.cfg);
    }
  }

  private async uninstallPlugins(): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.uninstall?.(this);
      } catch (err) {
        this.log?.error("Plugin uninstall failed", {
          plugin: plugin.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async runPrimary(start?: () => Promise<void> | void): Promise<void> {
    this.assertPrimaryCanRun();
    this.isPrimaryStarted = true;

    // Plugins must install BEFORE the worker count is resolved and workers are
    // forked, so plugin-driven overrides (worker count, worker env such as
    // NODE_OPTIONS) apply to the initial fleet — not only to restarted workers.
    await this.installPlugins();

    const workerCount = this.resolveWorkerCount();

    // Single-worker mode: run directly in primary without forking
    if (workerCount === 1) {
      this.startSingleWorkerPrimary();
      await start?.();
      return;
    }

    // Multi-worker mode: fork workers
    await this.startPrimary(workerCount);
  }

  private async runWorker(start?: () => Promise<void> | void): Promise<void> {
    this.assertWorkerCanRun();
    this.isWorkerStarted = true;
    // Plugins also install in worker processes (e.g. per-worker metric registries).
    await this.installPlugins();
    await this.startWorker(start);
  }

  /**
   * Register a plugin (chainable).
   */
  use(plugin: OrchestratorPlugin): this {
    this.plugins.push(plugin);
    return this;
  }

  /**
   * Merge additional env vars into workerEnv (chainable).
   * Must be called before workers are forked — a later call would produce a
   * fleet where restarted workers run with a different environment.
   */
  patchWorkerEnv(env: NodeJS.ProcessEnv): this {
    if (this.hasForked) {
      throw new Error("patchWorkerEnv: cannot be called after workers have been forked");
    }
    const dangerous = ["__proto__", "constructor", "prototype"];
    for (const key of Object.keys(env)) {
      if (dangerous.includes(key)) {
        throw new Error(`patchWorkerEnv: key '${key}' is not allowed (prototype pollution risk)`);
      }
    }
    if (!this.cfg.workers.env) {
      this.cfg.workers.env = {};
    }
    Object.assign(this.cfg.workers.env, env);
    return this;
  }

  /**
   * Get the current resolved worker count.
   */
  get workerCount(): number {
    return this.resolveWorkerCount();
  }

  /**
   * Get metrics snapshot.
   */
  getMetrics(): WorkerMetrics {
    return { ...this.metrics };
  }

  /**
   * Get health status.
   */
  getHealth(): HealthStatus {
    return { ...this.health };
  }

  /**
   * Mark the orchestrator as not ready.
   */
  setNotReady(): void {
    this.health.ready = false;
  }

  /**
   * Mark the orchestrator as ready again (no-op while a shutdown is in progress).
   */
  setReady(): void {
    if (this.shutdownCoordinator.isShutdownInProgress() || this.localShutdownInProgress) {
      return;
    }
    this.health.ready = true;
  }

  /**
   * Reset the crash-loop circuit breaker and restart backoff, and restore
   * readiness. After a trip, call this once the underlying cause is fixed to
   * allow crashed workers to be restarted again; missing capacity is refilled.
   */
  resetCircuitBreaker(): this {
    this.crashTracker.reset();
    this.restartBackoffDelay = 0;

    if (!this.shutdownCoordinator.isShutdownInProgress()) {
      this.health.ready = true;

      // Refill any capacity lost while the breaker was tripped
      if (this.hasForked) {
        const missing = Math.max(0, this.resolveWorkerCount() - this.metrics.activeWorkers);
        for (let i = 0; i < missing; i++) {
          this.pendingRestartQueue.push({ workerId: 0, code: null, signal: null });
        }
        if (missing > 0) {
          this.kickRestartQueue();
        }
      }
    }

    this.log?.info("Circuit breaker reset");
    return this;
  }

  /**
   * Register a shutdown callback.
   */
  registerOnShutdown(cb: (signal: string) => void | Promise<void>): void {
    this.shutdownCallbacks.push(cb);
  }

  /**
   * Override the worker count (only works when configured as 'auto').
   * Must be called before workers are forked (e.g. from a plugin install hook).
   */
  overrideWorkerCount(n: number): this {
    if (n < 1 || !Number.isInteger(n)) {
      throw new Error("overrideWorkerCount: must be a positive integer");
    }
    if (this.cfg.workers.count !== "auto") {
      throw new Error("overrideWorkerCount: can only override when workers is 'auto'");
    }
    if (this.hasForked) {
      throw new Error("overrideWorkerCount: cannot be called after workers have been forked");
    }
    this.cfg.workers.count = n;
    this.log?.info("Worker count overridden", { workers: n });
    return this;
  }

  // ============================================================================
  // Primary startup
  // ============================================================================

  private async startPrimary(workerCount: number): Promise<void> {
    // Raise process.maxListeners only if needed
    const needed = workerCount + 10;
    if (needed > process.getMaxListeners()) {
      process.setMaxListeners(needed);
    }

    // Initial fork
    this.hasForked = true;
    this.workerManager.forkWorkers(workerCount);

    // Signal handlers
    this.signalHandler.register({
      SIGTERM: () => this.handleShutdownSignal("SIGTERM"),
      SIGINT: () => this.handleShutdownSignal("SIGINT"),
      SIGHUP: () => {
        // No-op - prevents Node.js default behavior
      },
    });

    // Periodic crash tracker cleanup
    this.crashCleanupInterval = setInterval(() => {
      if (!this.shutdownCoordinator.isShutdownInProgress()) {
        this.crashTracker.prune();
      }
    }, 5 * 60_000).unref();

    // Start worker recycling if enabled
    this.workerManager.startRecycling(
      () => this.shutdownCoordinator.isShutdownInProgress(),
      (oldWorker, newWorker) => this.handleWorkerRecycle(oldWorker, newWorker),
    );

    this.log?.info("Primary started", { workerCount });
  }

  private handleShutdownSignal(signal: string): void {
    this.shutdownPrimary(signal).catch((err) => {
      this.log?.error("Primary shutdown failed", {
        signal,
        error: err instanceof Error ? err.message : String(err),
      });
      process.exitCode = 1;
    });
  }

  // ============================================================================
  // Single-worker mode (no fork — the app runs inside the primary process)
  // ============================================================================

  private startSingleWorkerPrimary(): void {
    // Without these handlers a PID 1 process ignores SIGTERM entirely and
    // `docker stop` escalates to SIGKILL without ever draining the app.
    this.signalHandler.register({
      SIGTERM: () => void this.shutdownSingleWorker("SIGTERM"),
      SIGINT: () => void this.shutdownSingleWorker("SIGINT"),
      SIGHUP: () => {
        // No-op - prevents Node.js default behavior
      },
    });

    this.log?.info("Primary started in single-worker mode (no fork)");
  }

  private async shutdownSingleWorker(signal: string): Promise<void> {
    if (this.localShutdownInProgress) return;
    this.localShutdownInProgress = true;

    this.health.ready = false;
    this.safeEmit("shutdown:start", { signal });
    this.log?.info("Single-worker shutdown initiated", { signal });

    this.signalHandler.unregister();

    let shutdownTimedOut = false;
    const exitTimer = setTimeout(() => {
      shutdownTimedOut = true;
      this.log?.error("Forced exit after shutdown timeout", { timeoutMs: this.cfg.shutdown.timeoutMs });
      process.exit(1);
    }, this.cfg.shutdown.timeoutMs).unref();

    try {
      await this.runShutdownCallbacks(signal);
      await this.uninstallPlugins();
      this.safeEmit("shutdown:complete", { metrics: { ...this.metrics } });
      this.log?.info("Single-worker shutdown complete");
    } finally {
      clearTimeout(exitTimer);
      if (!shutdownTimedOut) {
        process.exit(0);
      }
    }
  }

  // ============================================================================
  // Worker lifecycle handlers
  // ============================================================================

  private handleWorkerOnline(worker: Worker): void {
    // Reset backoff only after a sustained crash-free window
    if (this.restartBackoffDelay > 0) {
      this.scheduleBackoffReset(worker.id);
    }

    this.safeEmit("worker:online", { workerId: worker.id, pid: worker.process.pid ?? 0 });
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

      if (this.shutdownCoordinator.isShutdownInProgress() || this.restartBackoffDelay === 0) {
        return;
      }

      this.restartBackoffDelay = 0;
      this.log?.info("Cluster remained stable, reset restart backoff", {
        stabilityWindowMs: this.cfg.restart.stabilityWindowMs,
      });
    }, this.cfg.restart.stabilityWindowMs).unref();
  }

  private clearBackoffResetTimer(): void {
    clearTimeout(this.backoffResetTimer);
    this.backoffResetTimer = undefined;
  }

  private handleWorkerExit(worker: Worker, code: number | null, signal: string | null): void {
    this.safeEmit("worker:exit", {
      workerId: worker.id,
      pid: worker.process.pid ?? 0,
      code,
      signal,
      graceful: worker.exitedAfterDisconnect,
    });

    // During shutdown: do not restart but emit and record events
    if (this.shutdownCoordinator.isShutdownInProgress()) {
      this.log?.info("Worker exited during shutdown", { workerId: worker.id, code, signal });
      if (worker.exitedAfterDisconnect) {
        this.metrics.gracefulShutdowns++;
      }
      return;
    }

    // Any crash breaks stability and cancels pending backoff reset
    if (!worker.exitedAfterDisconnect) {
      this.clearBackoffResetTimer();
    }

    // Clean exit
    if (worker.exitedAfterDisconnect) {
      this.log?.info("Worker exited gracefully", { workerId: worker.id, code, signal });
      this.metrics.gracefulShutdowns++;
      return;
    }

    // Crash - record for circuit breaker (ALWAYS record, even if restart is locked)
    this.safeEmit("worker:crash", {
      workerId: worker.id,
      pid: worker.process.pid ?? 0,
      code,
      signal,
    });
    this.crashTracker.record();

    if (this.crashTracker.isTripped()) {
      this.log?.error("Crash loop detected — stopping restarts", {
        crashCount: this.crashTracker.count,
        windowMs: this.cfg.restart.crashWindowMs,
      });
      // A tripped breaker means the cluster can no longer maintain capacity:
      // flip readiness so load balancers / probes stop routing traffic here.
      this.health.ready = false;
      this.safeEmit("circuit-breaker:tripped", {
        crashCount: this.crashTracker.count,
        windowMs: this.cfg.restart.crashWindowMs,
      });
      this.metrics.crashLoopBackoffs++;
      return;
    }

    // Queue restart and process asynchronously
    this.pendingRestartQueue.push({ workerId: worker.id, code, signal });
    this.kickRestartQueue();
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
        if (this.shutdownCoordinator.isShutdownInProgress()) {
          this.pendingRestartQueue = [];
          return;
        }

        const crashed = this.pendingRestartQueue.shift();
        if (!crashed) return;

        // Workers being recycled are still alive but already have a replacement
        // (or are about to exit) — exclude them so a crash overlapping a recycle
        // is not silently dropped, leaving the cluster under capacity.
        const targetWorkers = this.resolveWorkerCount();
        const settledWorkers = this.metrics.activeWorkers - this.workerManager.getRecyclingCount();
        const missingWorkers = Math.max(0, targetWorkers - settledWorkers);
        if (missingWorkers === 0) {
          continue;
        }

        await this.restartWorkerWithBackoff(crashed.workerId, crashed.code, crashed.signal);
      }
    } finally {
      this.restartLoopRunning = false;

      if (this.pendingRestartQueue.length > 0 && !this.shutdownCoordinator.isShutdownInProgress()) {
        this.kickRestartQueue();
      }
    }
  }

  private async restartWorkerWithBackoff(
    crashedWorkerId: number,
    code: number | null,
    signal: string | null,
  ): Promise<void> {
    const delayMs = this.restartBackoffDelay > 0 ? this.restartBackoffDelay : this.cfg.restart.backoffMs;

    if (delayMs > 0) {
      this.log?.info("Waiting before restart", { delayMs, workerId: crashedWorkerId });
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      // Double check shutdown hasn't started during wait
      if (this.shutdownCoordinator.isShutdownInProgress()) {
        this.log?.info("Shutdown started during backoff, aborting restart", { workerId: crashedWorkerId });
        return;
      }
    }

    this.log?.warn("Worker crashed, restarting", { workerId: crashedWorkerId, code, signal });
    const newWorker = this.workerManager.forkWorker();
    this.metrics.workerRestarts++;
    this.safeEmit("worker:restart", { newWorkerId: newWorker.id, newPid: newWorker.process.pid ?? 0 });

    // Increase backoff for next restart
    // First restart: use initial delay, others: multiply by factor
    const nextDelay = delayMs > 0 ? delayMs * this.cfg.restart.backoffMultiplier : this.cfg.restart.backoffMs;
    this.restartBackoffDelay = Math.min(nextDelay, this.cfg.restart.maxBackoffMs);
  }

  private handleWorkerRecycle(oldWorker: Worker, newWorker: Worker): void {
    const ageMs = this.workerManager.getWorkerAge(oldWorker.id);
    this.safeEmit("worker:recycle", {
      workerId: oldWorker.id,
      pid: oldWorker.process.pid ?? 0,
      ageMs,
    });

    // Disconnect old worker after new one is online
    newWorker.once("online", () => {
      if (this.shutdownCoordinator.isShutdownInProgress()) return;

      try {
        oldWorker.send({ type: this.shutdownType });
        if (!oldWorker.isDead()) oldWorker.disconnect();
      } catch {
        /* worker already dead */
      }

      if (oldWorker.isDead()) return;

      // Escalate: after 5s send SIGTERM, after 2s more send SIGKILL.
      // Calling disconnect() again is a no-op on an already-disconnected
      // worker, so we must escalate to signals to prevent a stuck worker
      // from leaking.
      //
      // The sigkillTimer's exit listener is registered inside the
      // forceKillTimer callback — so if the worker exits after SIGTERM
      // (before the 2s SIGKILL window), the timer is cleared. Both
      // listeners use once(), so no listener accumulation across recycles.
      const forceKillTimer = setTimeout(() => {
        if (!oldWorker.isDead() && !this.shutdownCoordinator.isShutdownInProgress()) {
          try {
            oldWorker.process.kill("SIGTERM");
          } catch {
            /* already dead */
          }
          const sigkillTimer = setTimeout(() => {
            if (!oldWorker.isDead() && !this.shutdownCoordinator.isShutdownInProgress()) {
              try {
                oldWorker.process.kill("SIGKILL");
                this.metrics.forcedKills++;
              } catch {
                /* already dead */
              }
            }
          }, 2_000);
          sigkillTimer.unref();
          oldWorker.once("exit", () => clearTimeout(sigkillTimer));
        }
      }, 5_000);
      forceKillTimer.unref();
      oldWorker.once("exit", () => clearTimeout(forceKillTimer));
    });
  }

  // ============================================================================
  // Shutdown coordination
  // ============================================================================

  async shutdownPrimary(signal: string): Promise<void> {
    if (this.shutdownCoordinator.isShutdownInProgress()) return;

    // Stop intervals
    clearInterval(this.crashCleanupInterval);
    this.clearBackoffResetTimer();
    this.workerManager.stopRecycling();

    // Remove signal handlers
    this.signalHandler.unregister();

    // Mark not ready
    this.health.ready = false;

    // Get workers and initiate shutdown
    const workers = this.workerManager.getActiveWorkers();
    await this.shutdownCoordinator.initiateShutdown(workers, signal);

    // Uninstall plugins
    await this.uninstallPlugins();

    // Cleanup worker manager
    this.workerManager.dispose();

    // Exit
    process.exitCode = 0;
  }

  private handleShutdownStart(signal: string): void {
    this.safeEmit("shutdown:start", { signal });
    this.log?.info("Primary shutdown initiated", { signal });
  }

  private handleShutdownComplete(metrics: WorkerMetrics): void {
    this.safeEmit("shutdown:complete", { metrics: { ...metrics } });
    this.log?.info("All workers terminated", { metrics });
  }

  // ============================================================================
  // Worker (child process)
  // ============================================================================

  private async startWorker(start?: () => Promise<void> | void): Promise<void> {
    const handleShutdown = async (signal: string): Promise<void> => {
      // A POSIX signal (e.g. Ctrl+C delivered to the process group) and the
      // primary's IPC shutdown message can arrive concurrently — run the
      // shutdown sequence only once.
      if (this.localShutdownInProgress) return;
      this.localShutdownInProgress = true;

      this.health.ready = false;
      this.log?.info("Worker shutting down", { signal });

      let shutdownTimedOut = false;

      const exitTimer = setTimeout(() => {
        shutdownTimedOut = true;
        this.log?.error("Worker forced exit after timeout", {
          timeoutMs: this.cfg.shutdown.timeoutMs,
        });
        process.exit(1);
      }, this.cfg.shutdown.timeoutMs).unref();

      try {
        await this.runShutdownCallbacks(signal);
        this.log?.info("Worker shutdown complete");
      } finally {
        clearTimeout(exitTimer);
        if (!shutdownTimedOut) {
          process.exit(0);
        }
      }
    };

    // POSIX signals
    for (const sig of ["SIGTERM", "SIGINT"] as NodeJS.Signals[]) {
      process.on(sig, () => void handleShutdown(sig));
    }

    // IPC message from primary
    process.on("message", (msg) => {
      if (this.isShutdownMessage(msg)) {
        try {
          process.send?.({ type: this.shutdownAckType });
        } catch {
          /* IPC channel already closed (e.g. recycle disconnect) — drain anyway */
        }
        void handleShutdown("IPC");
      }
    });

    await start?.();
  }

  private async runShutdownCallbacks(signal: string): Promise<void> {
    for (const cb of this.shutdownCallbacks) {
      try {
        await cb(signal);
      } catch (err) {
        this.log?.error("Shutdown callback failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private isShutdownMessage(msg: unknown): msg is { type: string } {
    return isTypedMessage(msg, this.shutdownType);
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Emit without letting a throwing listener propagate into internal control
   * flow (signal handlers, cluster event handlers, restart loop) — a user or
   * plugin listener error must never take down the primary.
   */
  private safeEmit<K extends keyof OrchestratorEvents>(event: K, ...args: OrchestratorEvents[K]): void {
    try {
      // @types/node types emit() with a conditional on K that does not narrow
      // for a generic K — the cast is safe since args is OrchestratorEvents[K]
      (this.emit as (event: K, ...args: OrchestratorEvents[K]) => boolean)(event, ...args);
    } catch (err) {
      this.log?.error("Uncaught error in event listener", {
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private resolveWorkerCount(): number {
    if (this.cfg.workers.count !== "auto") {
      return this.cfg.workers.count;
    }

    // Cache the auto resolution: cgroup limits cannot change for a running
    // container, and re-reading them does sync fs work on the event loop.
    if (this.cachedAutoWorkerCount === undefined) {
      this.cachedAutoWorkerCount = this.computeAutoWorkerCount();
    }
    return this.cachedAutoWorkerCount;
  }

  private computeAutoWorkerCount(): number {
    const webConcurrency = process.env.WEB_CONCURRENCY;
    if (webConcurrency) {
      const parsed = Number.parseInt(webConcurrency, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        if (parsed > MAX_AUTO_WORKERS) {
          this.log?.warn("WEB_CONCURRENCY exceeds the maximum supported worker count — clamping", {
            requested: parsed,
            max: MAX_AUTO_WORKERS,
          });
          return MAX_AUTO_WORKERS;
        }
        return parsed;
      }
    }

    return getCPUCount();
  }
}

// Re-export types for convenience

export type { OrchestratorConfig, OrchestratorPlugin } from "./types";
