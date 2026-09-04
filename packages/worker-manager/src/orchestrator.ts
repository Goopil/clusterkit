import cluster, { type Worker } from "node:cluster";
import { EventEmitter } from "node:events";
import { CrashTracker } from "./crash-tracker";
import { DrainCoordinator } from "./drain-coordinator";
import { HealthMonitor } from "./health-monitor";
import { withLoggerPrefix } from "./logger";
import { detectReusePortSupport, getPlatformCapabilities, type PlatformCapabilities } from "./platform";
import { MAX_CONSECUTIVE_FORK_FAILURES, RestartCoordinator } from "./restart-coordinator";
import { ShutdownCoordinator } from "./shutdown-coordinator";
import { getCPUCount } from "./sizing";
import {
  type FleetHealth,
  type HealthStatus,
  isTypedMessage,
  type Logger,
  type OrchestratorConfig,
  type OrchestratorEvents,
  type OrchestratorPlugin,
  type ResolvedConfig,
  type WorkerMetrics,
} from "./types";
import { assertSafeEnvObject, validateConfig } from "./validation";
import { WorkerManager } from "./worker-manager";

/** Upper bound applied to WEB_CONCURRENCY to guard against fork bombs from inherited env vars. */
const MAX_AUTO_WORKERS = 256;

/**
 * Main orchestrator that coordinates worker lifecycle, shutdown, and health.
 * Delegates specific concerns to specialized services:
 * - WorkerManager: fork, tracking, recycling
 * - ShutdownCoordinator: graceful shutdown sequence
 */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private readonly cfg: ResolvedConfig;
  private readonly baseLog: Logger | null;
  private readonly log: Logger | null;
  private readonly plugins: OrchestratorPlugin[] = [];

  // Services
  private readonly workerManager: WorkerManager;
  private readonly shutdownCoordinator: ShutdownCoordinator;
  private readonly restartCoordinator: RestartCoordinator;
  private readonly drainCoordinator: DrainCoordinator;
  private healthMonitor!: HealthMonitor;

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

  // Health — `live` is constant true by design (see HealthStatus): readiness is the signal.
  private readonly health: HealthStatus = { ready: true, live: true };

  // Circuit breaker
  private readonly crashTracker: CrashTracker;

  // Intervals
  private crashCleanupInterval?: NodeJS.Timeout;

  // Hot restart guard — prevents concurrent restartWorkers() calls
  private restartInProgress = false;

  // Fleet health degradation state (hysteresis before fleet:degraded)
  private fleetDegraded = false;
  private degradedSince = 0;
  private degradedTimer?: NodeJS.Timeout;

  // Registered POSIX signal handlers, tracked for symmetric cleanup
  private readonly signalHandlers: Array<[NodeJS.Signals, () => void]> = [];

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

    // Wire up service callbacks
    this.workerManager.setupEventHandlers(
      (worker) => this.handleWorkerOnline(worker),
      (worker, code, signal) => this.handleWorkerExit(worker, code, signal),
      (worker, msg) => this.healthMonitor.onWorkerMessage(worker.id, worker.process.pid ?? 0, msg),
    );

    this.shutdownCoordinator.setupCallbacks(
      (signal) => this.handleShutdownStart(signal),
      (metrics) => this.handleShutdownComplete(metrics),
    );

    this.restartCoordinator = new RestartCoordinator(
      this.cfg,
      withLoggerPrefix(this.baseLog, "clusterkit:restart-coordinator"),
      this.metrics,
      this.crashTracker,
      {
        forkWorker: () => this.workerManager.forkWorker(),
        isShuttingDown: () => this.shutdownCoordinator.isShutdownInProgress(),
        targetWorkerCount: () => this.resolveWorkerCount(),
        recyclingCount: () => this.workerManager.getRecyclingCount(),
        onRestarted: (worker) =>
          this.safeEmit("worker:restart", { newWorkerId: worker.id, newPid: worker.process.pid ?? 0 }),
        onBreakerTripped: (info) => {
          // A tripped breaker means the cluster can no longer maintain capacity:
          // flip readiness so load balancers / probes stop routing traffic here.
          this.health.ready = false;
          this.safeEmit("circuit-breaker:tripped", info);
        },
      },
    );

    this.drainCoordinator = new DrainCoordinator(
      this.cfg,
      withLoggerPrefix(this.baseLog, "clusterkit:drain-coordinator"),
      this.metrics,
      { isShuttingDown: () => this.shutdownCoordinator.isShutdownInProgress() },
    );

    this.healthMonitor = new HealthMonitor(this.cfg, withLoggerPrefix(this.baseLog, "clusterkit:health-monitor"), {
      isShuttingDown: () => this.shutdownCoordinator.isShutdownInProgress(),
      recycleWorker: (workerId, reason) => this.triggerWorkerRecycle(workerId, reason),
      onHealthReport: (report) => this.safeEmit("worker:health", report),
      onWedged: (info) => this.safeEmit("worker:wedged", info),
    });
  }

  // ============================================================================
  // Static platform helpers
  // ============================================================================

  static async supportsReusePort(): Promise<boolean> {
    return detectReusePortSupport();
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
    const installed: OrchestratorPlugin[] = [];
    for (const plugin of this.plugins) {
      try {
        await plugin.install(this, this.baseLog, this.cfg);
        installed.push(plugin);
      } catch (err) {
        // Roll back plugins already installed in this pass so a failing install
        // does not leave the instance half-configured. A failing uninstall must
        // not mask the original install error.
        for (const done of installed) {
          try {
            await done.uninstall?.(this);
          } catch (rollbackErr) {
            this.log?.error("Plugin rollback failed", {
              plugin: done.name,
              error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            });
          }
        }
        throw new Error(`Plugin '${plugin.name}' install failed: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
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
   * Must be called before run() — plugins are installed during startup; a
   * later registration would be silently ignored yet still uninstalled.
   */
  use(plugin: OrchestratorPlugin): this {
    if (this.isPrimaryStarted || this.isWorkerStarted) {
      throw new Error("use: cannot be called after run() — plugins must be registered before the orchestrator starts");
    }
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
    // Forbidden-key detection kept local: this long-standing public API keeps
    // its plain-Error surface (not WorkerManagerValidationError). Keys mirror
    // FORBIDDEN_ENV_KEYS in validation.ts.
    const forbidden = Object.keys(env).find(
      (key) => key === "__proto__" || key === "constructor" || key === "prototype",
    );
    if (forbidden) {
      throw new Error(`patchWorkerEnv: key '${forbidden}' is not allowed (prototype pollution risk)`);
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
   * Fleet-level health snapshot: capacity vs target, quarantined slots,
   * breaker state.
   */
  getFleetHealth(): FleetHealth {
    // getQuarantinedCount() arrives with worker quarantine; read it through
    // an optional chain until then.
    const restartCoordinator = this.restartCoordinator as unknown as {
      getQuarantinedCount?: () => number;
    };
    return {
      target: this.resolveWorkerCount(),
      active: this.metrics.activeWorkers,
      quarantined: restartCoordinator.getQuarantinedCount?.() ?? 0,
      breaker: { count: this.crashTracker.count, tripped: this.crashTracker.isTripped() },
    };
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
    this.restartCoordinator.reset();

    if (!this.shutdownCoordinator.isShutdownInProgress()) {
      this.health.ready = true;

      // The operator declared the underlying cause fixed: clear the failure
      // exit code flagged when the breaker tripped or the fleet emptied
      // (see handleWorkerExit).
      process.exitCode = 0;

      // Refill any capacity lost while the breaker was tripped
      if (this.hasForked) {
        const missing = Math.max(0, this.resolveWorkerCount() - this.metrics.activeWorkers);
        this.restartCoordinator.requestCapacityRefill(missing);
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
   * Rolling-restart all (or filtered) workers without dropping connections.
   * Forks a replacement for each worker, then drains the old one via the
   * same `handleWorkerRecycle` path used by age-based recycling.
   *
   * The wait for each old worker's exit is bounded by the total shutdown
   * budget plus a margin, force-killing a worker that outlives it — a
   * replacement that never reaches `online` would otherwise leave the old
   * worker undrained and deadlock the roll (and the `restartInProgress`
   * guard) forever.
   *
   * Idempotent: no-op if a restart is already in progress or shutdown has
   * started. Returns early in single-worker mode (no cluster to roll).
   * If shutdown starts mid-roll, the roll stops without emitting
   * `restart:complete` — a partial roll is not a complete one.
   *
   * Throws before any state change if the env overlay contains
   * prototype-pollution keys — no worker is marked for recycling and no
   * `restart:start` is emitted for an aborted roll.
   */
  async restartWorkers(opts?: {
    env?: NodeJS.ProcessEnv;
    filter?: (workerId: number) => boolean;
    staggerMs?: number;
    reason?: string;
  }): Promise<void> {
    // Fail fast on a polluted env overlay before any state change: an aborted
    // roll must not leave old workers marked for recycling (which would exempt
    // them from age-based recycling) or emit a dangling restart:start.
    assertSafeEnvObject(opts?.env, "env overlay");

    const reason = opts?.reason ?? "manual";

    if (this.shutdownCoordinator.isShutdownInProgress()) {
      this.log?.warn("restartWorkers() ignored — shutdown in progress", { reason });
      return;
    }

    if (this.restartInProgress) {
      this.log?.warn("restartWorkers() ignored — restart already in progress", { reason });
      return;
    }

    if (this.workerCount === 1) {
      this.log?.warn("restartWorkers() called in single-worker mode — no cluster to roll", { reason });
      return;
    }

    this.restartInProgress = true;

    try {
      const staggerMs = opts?.staggerMs ?? 1_000;
      const workers = this.workerManager.getActiveWorkers();
      const filter = opts?.filter;
      const targeted = filter ? workers.filter((w) => filter(w.id)) : workers;
      const workerIds = targeted.map((w) => w.id);

      this.log?.info("Hot restart initiated", { reason, workerIds });
      this.safeEmit("restart:start", { reason, workerIds });

      const restartedWorkerIds: number[] = [];
      let abortedByShutdown = false;
      let forkFailureBailout = false;

      for (const oldWorker of targeted) {
        if (this.shutdownCoordinator.isShutdownInProgress()) {
          abortedByShutdown = true;
          break;
        }

        // A worker that exited between the snapshot and its turn already had
        // its replacement forked by the crash-restart path: marking a dead id
        // would leak a stale recycling mark (the 'exit' cleanup already ran)
        // and inflate the recycling count, and the bounded exit wait would
        // stall for the full drain budget on an exit event that already fired.
        if (oldWorker.isDead()) {
          this.log?.warn("Hot restart skipped worker — already exited", { workerId: oldWorker.id });
          continue;
        }

        let newWorker: Worker;
        try {
          newWorker = this.workerManager.forkWorker(opts?.env);
        } catch (err) {
          // A fork failure (EMFILE/ENOMEM...) leaves the old worker running
          // (still serving) — better than an unhandled exception killing the
          // primary. The worker is NOT marked for recycling.
          const attempt = this.restartCoordinator.noteForkFailure();
          this.log?.error("Hot restart fork failed — old worker left running", {
            workerId: oldWorker.id,
            attempt,
            maxAttempts: MAX_CONSECUTIVE_FORK_FAILURES,
            error: err instanceof Error ? err.message : String(err),
          });
          if (this.restartCoordinator.isForkEnvUnrecoverable()) {
            forkFailureBailout = true;
            break;
          }
          continue;
        }
        this.restartCoordinator.noteForkSuccess();

        // Mark only once the replacement exists, so a failed fork never leaks
        // a recycling mark for a worker that is still alive and serving.
        this.workerManager.markForRecycling(oldWorker.id);

        this.handleWorkerRecycle(oldWorker, newWorker);

        await this.drainCoordinator.awaitBoundedWorkerExit(oldWorker);

        restartedWorkerIds.push(oldWorker.id);

        if (staggerMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, staggerMs));
        }
      }

      if (abortedByShutdown) {
        // A partial roll is not a complete roll: emit nothing — listeners
        // must not mistake a partial restartedWorkerIds list for a finished
        // restart (e.g. plugins that release resources on completion).
        this.log?.warn("Hot restart aborted by shutdown", { reason, restartedWorkerIds });
      } else if (forkFailureBailout) {
        // Unrecoverable fork environment: flag a failure exit code (same
        // protocol as a breaker trip). A partial roll is not a complete roll.
        process.exitCode = 1;
        this.log?.error("Hot restart abandoned — fork failing repeatedly", { reason, restartedWorkerIds });
      } else {
        this.log?.info("Hot restart complete", { reason, restartedWorkerIds });
        this.safeEmit("restart:complete", { restartedWorkerIds, reason });
      }
    } finally {
      this.restartInProgress = false;
    }
  }

  /**
   * Override the worker count (only works when configured as 'auto').
   * Must be called before workers are forked (e.g. from a plugin install hook).
   */
  overrideWorkerCount(n: number): this {
    if (n < 1 || !Number.isInteger(n)) {
      throw new Error("overrideWorkerCount: must be a positive integer");
    }
    if (n > MAX_AUTO_WORKERS) {
      throw new Error(`overrideWorkerCount: exceeds the maximum of ${MAX_AUTO_WORKERS} workers`);
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
    // Signal handlers must be registered BEFORE the first fork: a SIGTERM
    // arriving in the boot window must trigger a graceful shutdown (which
    // no-ops safely on an empty fleet) instead of Node's default handler
    // killing the primary and orphaning the workers (#93).
    this.registerSignalHandlers({
      SIGTERM: () => this.handleShutdownSignal("SIGTERM"),
      SIGINT: () => this.handleShutdownSignal("SIGINT"),
      SIGHUP: () => {
        // No-op - prevents Node.js default behavior
      },
    });

    // Raise process.maxListeners only if needed
    const needed = workerCount + 10;
    if (needed > process.getMaxListeners()) {
      process.setMaxListeners(needed);
    }

    // Initial fork
    this.hasForked = true;
    this.workerManager.forkWorkers(workerCount);

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
    this.registerSignalHandlers({
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

    this.unregisterSignalHandlers();

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
    this.restartCoordinator.onWorkerOnline(worker.id);

    // Fleet back at target capacity: a failure exit code flagged while the
    // fleet was down (see handleWorkerExit) is resolved.
    if (this.metrics.activeWorkers >= this.resolveWorkerCount()) {
      process.exitCode = 0;
    }

    this.safeEmit("worker:online", { workerId: worker.id, pid: worker.process.pid ?? 0 });

    this.recomputeFleetHealth();
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

    // Capacity just changed (the exited worker was already untracked) — both
    // the graceful and the crash path below must re-evaluate fleet health.
    this.recomputeFleetHealth();

    // Any crash breaks stability and cancels pending backoff reset
    if (!worker.exitedAfterDisconnect) {
      this.restartCoordinator.cancelBackoffReset();
    }

    // Clean exit
    if (worker.exitedAfterDisconnect) {
      this.log?.info("Worker exited gracefully", { workerId: worker.id, code, signal });
      this.metrics.gracefulShutdowns++;
      return;
    }

    // Crash - record for circuit breaker and decide restart/breaker fate
    this.safeEmit("worker:crash", {
      workerId: worker.id,
      pid: worker.process.pid ?? 0,
      code,
      signal,
    });
    this.restartCoordinator.onWorkerCrash(worker.id, code, signal);
  }

  /**
   * Re-evaluate fleet health after a capacity change: arm the degradation
   * hysteresis when below target, clear it and emit `fleet:recovered` when
   * capacity is restored. No-op during shutdown, and disabled entirely when
   * `health.degradedAfterMs` is 0 (default) — config is immutable at runtime,
   * so a disabled config can never have an armed timer or degraded state.
   * Also skipped on the shutdown path of handleWorkerExit.
   */
  private recomputeFleetHealth(): void {
    if (this.shutdownCoordinator.isShutdownInProgress() || this.cfg.health.degradedAfterMs <= 0) return;
    const target = this.resolveWorkerCount();
    if (this.metrics.activeWorkers >= target) {
      if (this.degradedTimer) {
        clearTimeout(this.degradedTimer);
        this.degradedTimer = undefined;
      }
      if (this.fleetDegraded) {
        this.fleetDegraded = false;
        this.safeEmit("fleet:recovered", {
          target,
          active: this.metrics.activeWorkers,
          degradedDurationMs: Date.now() - this.degradedSince,
        });
      }
      return;
    }
    if (this.fleetDegraded || this.degradedTimer) return;
    this.degradedSince = Date.now();
    this.degradedTimer = setTimeout(() => {
      this.degradedTimer = undefined;
      if (this.shutdownCoordinator.isShutdownInProgress()) return;
      this.fleetDegraded = true;
      this.safeEmit("fleet:degraded", { target: this.resolveWorkerCount(), active: this.metrics.activeWorkers });
    }, this.cfg.health.degradedAfterMs).unref();
  }

  private handleWorkerRecycle(oldWorker: Worker, newWorker: Worker): void {
    const ageMs = this.workerManager.getWorkerAge(oldWorker.id);
    this.safeEmit("worker:recycle", {
      workerId: oldWorker.id,
      pid: oldWorker.process.pid ?? 0,
      ageMs,
    });
    this.drainCoordinator.recycle(oldWorker, newWorker);
  }

  private triggerWorkerRecycle(_workerId: number, _reason: "rss" | "wedged"): void {}

  // ============================================================================
  // Shutdown coordination
  // ============================================================================

  async shutdownPrimary(signal: string): Promise<void> {
    if (this.shutdownCoordinator.isShutdownInProgress()) return;

    // Stop intervals
    clearInterval(this.crashCleanupInterval);
    this.restartCoordinator.cancelBackoffReset();
    this.workerManager.stopRecycling();
    this.healthMonitor.stop();

    // Clear fleet health hysteresis state: no degraded/recovered after shutdown
    if (this.degradedTimer) clearTimeout(this.degradedTimer);
    this.degradedTimer = undefined;
    this.fleetDegraded = false;

    // Remove signal handlers
    this.unregisterSignalHandlers();

    // Mark not ready
    this.health.ready = false;

    // Get workers and initiate shutdown
    const workers = this.workerManager.getActiveWorkers();
    await this.shutdownCoordinator.initiateShutdown(workers, signal);

    // Failsafe: user callbacks and plugin uninstall are unbounded async work —
    // one callback that never resolves would hang the primary after SIGTERM
    // forever. Single-worker mode and worker children have the same failsafe.
    let shutdownTimedOut = false;
    const exitTimer = setTimeout(() => {
      shutdownTimedOut = true;
      this.log?.error("Forced exit after shutdown timeout", { timeoutMs: this.cfg.shutdown.timeoutMs });
      process.exit(1);
    }, this.cfg.shutdown.timeoutMs).unref();

    try {
      await this.runShutdownCallbacks(signal);

      // Uninstall plugins
      await this.uninstallPlugins();

      // Emitted after user callbacks and plugin uninstall (same contract as
      // single-worker mode) — plugins doing final work must do it in
      // uninstall(): their shutdown:complete listener is gone by then.
      this.safeEmit("shutdown:complete", { metrics: { ...this.metrics } });
    } finally {
      clearTimeout(exitTimer);
    }

    // Cleanup worker manager
    this.workerManager.dispose();

    // Exit
    if (!shutdownTimedOut) {
      process.exitCode = 0;
    }
  }

  private handleShutdownStart(signal: string): void {
    this.safeEmit("shutdown:start", { signal });
    this.log?.info("Primary shutdown initiated", { signal });
  }

  private handleShutdownComplete(metrics: WorkerMetrics): void {
    // No shutdown:complete emission here: the event is emitted at the end of
    // shutdownPrimary(), after user callbacks and plugin uninstall, matching
    // single-worker mode.
    this.log?.info("All workers terminated", { metrics });
  }

  // ============================================================================
  // Worker (child process)
  // ============================================================================

  private async startWorker(start?: () => Promise<void> | void): Promise<void> {
    const handleShutdown = async (signal: string): Promise<void> => {
      this.healthMonitor.stopWorkerReporting();
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

    this.healthMonitor.startWorkerReporting();
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

  private registerSignalHandlers(handlers: Partial<Record<NodeJS.Signals, () => void>>): void {
    for (const [signal, handler] of Object.entries(handlers)) {
      if (!handler) continue;
      process.on(signal as NodeJS.Signals, handler);
      this.signalHandlers.push([signal as NodeJS.Signals, handler]);
    }
  }

  private unregisterSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers) {
      process.off(signal, handler);
    }
    this.signalHandlers.length = 0;
  }

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
    this.cachedAutoWorkerCount ??= this.computeAutoWorkerCount();
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
      this.log?.warn("WEB_CONCURRENCY is set but not a valid positive integer — falling back to CPU count", {
        value: webConcurrency,
      });
    }

    return getCPUCount();
  }
}

// Re-export types for convenience

export type { OrchestratorConfig, OrchestratorPlugin } from "./types";
