import type cluster from "node:cluster";
import type { Worker } from "node:cluster";
import type { Logger, ResolvedConfig, WorkerMetrics } from "./types";

/**
 * Manages worker lifecycle: forking, tracking, recycling, and crash handling.
 * Decoupled from shutdown coordination to keep concerns separate.
 */
export class WorkerManager {
  private readonly clusterRef: typeof cluster;
  private readonly cfg: ResolvedConfig;
  private readonly log: Logger | null;
  private readonly metrics: WorkerMetrics;
  private readonly baseWorkerExecArgv: string[];

  // Worker tracking
  private readonly workerStartTimes = new Map<number, number>();
  private readonly recyclingWorkerIds = new Set<number>();
  private readonly pendingRecycleTimers = new Map<number, NodeJS.Timeout>();
  private recycleInterval?: NodeJS.Timeout;

  // Prevent duplicate execArgv setup on restarts
  private appliedExecArgv = false;

  // Event callback (injected from Orchestrator)
  private onWorkerOnlineCallback?: (worker: Worker) => void;
  private onWorkerExitCallback?: (worker: Worker, code: number | null, signal: string | null) => void;
  private clusterOnlineListener?: (worker: Worker) => void;
  private clusterExitListener?: (worker: Worker, code: number | null, signal: string | null) => void;

  constructor(
    clusterRef: typeof cluster,
    cfg: ResolvedConfig,
    log: Logger | null,
    metrics: WorkerMetrics,
    baseWorkerExecArgv: string[],
  ) {
    this.clusterRef = clusterRef;
    this.cfg = cfg;
    this.log = log;
    this.metrics = metrics;
    this.baseWorkerExecArgv = baseWorkerExecArgv;
  }

  /**
   * Set up cluster event handlers.
   * Must be called after construction.
   */
  setupEventHandlers(
    onOnline: (worker: Worker) => void,
    onExit: (worker: Worker, code: number | null, signal: string | null) => void,
  ): void {
    this.onWorkerOnlineCallback = onOnline;
    this.onWorkerExitCallback = onExit;

    if (this.clusterExitListener) {
      this.clusterRef.off("exit", this.clusterExitListener);
    }
    if (this.clusterOnlineListener) {
      this.clusterRef.off("online", this.clusterOnlineListener);
    }

    this.clusterExitListener = (worker, code, signal) => this.handleWorkerExit(worker, code, signal);
    this.clusterOnlineListener = (worker) => this.handleWorkerOnline(worker);

    this.clusterRef.on("exit", this.clusterExitListener).on("online", this.clusterOnlineListener);
  }

  /**
   * Fork a new worker with the configured environment.
   */
  forkWorker(envOverlay?: NodeJS.ProcessEnv): Worker {
    if (!this.appliedExecArgv && this.cfg.workers.execArgv?.length) {
      this.clusterRef.setupPrimary({
        execArgv: [...this.baseWorkerExecArgv, ...this.cfg.workers.execArgv],
      });
      this.appliedExecArgv = true;
    }

    const env = envOverlay !== undefined ? { ...this.cfg.workers.env, ...envOverlay } : this.cfg.workers.env;
    const worker = this.clusterRef.fork(env);
    this.workerStartTimes.set(worker.id, Date.now());
    this.metrics.activeWorkers++;
    return worker;
  }

  /**
   * Fork multiple workers at once.
   */
  forkWorkers(count: number): Worker[] {
    const workers: Worker[] = [];
    for (let i = 0; i < count; i++) {
      workers.push(this.forkWorker());
    }
    return workers;
  }

  /**
   * Get all active workers.
   */
  getActiveWorkers(): Worker[] {
    return Object.values(this.clusterRef.workers ?? {}).filter((w): w is Worker => w !== undefined && !w.isDead());
  }

  /**
   * Get worker age in milliseconds.
   */
  getWorkerAge(workerId: number): number {
    const startTime = this.workerStartTimes.get(workerId);
    if (!startTime) return 0;
    return Date.now() - startTime;
  }

  /**
   * Mark a worker for recycling.
   */
  markForRecycling(workerId: number): void {
    this.recyclingWorkerIds.add(workerId);
  }

  /**
   * Check if a worker is marked for recycling.
   */
  isMarkedForRecycling(workerId: number): boolean {
    return this.recyclingWorkerIds.has(workerId);
  }

  /**
   * Number of workers currently marked for recycling (still alive, but with a
   * replacement forked or scheduled).
   */
  getRecyclingCount(): number {
    return this.recyclingWorkerIds.size;
  }

  /**
   * Start age-based worker recycling.
   * Workers older than workers.maxAgeMs are gradually replaced.
   */
  startRecycling(isShuttingDown: () => boolean, onRecycle: (worker: Worker, newWorker: Worker) => void): void {
    if (this.cfg.workers.maxAgeMs <= 0) return;

    this.recycleInterval = setInterval(() => {
      if (isShuttingDown()) return;

      const workers = this.getActiveWorkers();
      const toRecycle = workers.filter((w) => {
        if (this.recyclingWorkerIds.has(w.id)) return false;
        const age = this.getWorkerAge(w.id);
        return age > this.cfg.workers.maxAgeMs;
      });

      toRecycle.forEach((worker, idx) => {
        this.recyclingWorkerIds.add(worker.id);

        // Stagger by 30s per worker to avoid simultaneous traffic drops
        const staggerTimer = setTimeout(() => {
          this.pendingRecycleTimers.delete(worker.id);
          if (worker.isDead() || isShuttingDown()) {
            this.recyclingWorkerIds.delete(worker.id);
            return;
          }

          const ageMs = this.getWorkerAge(worker.id);
          this.log?.info("Recycling aged worker", { workerId: worker.id, ageMs });

          // Start replacement worker first (rolling restart pattern)
          const newWorker = this.forkWorker();
          onRecycle(worker, newWorker);
        }, idx * 30_000);

        this.pendingRecycleTimers.set(worker.id, staggerTimer);
      });
    }, 60_000).unref();
  }

  /**
   * Stop recycling and cleanup timers.
   */
  stopRecycling(): void {
    clearInterval(this.recycleInterval);
    for (const timer of this.pendingRecycleTimers.values()) clearTimeout(timer);
    this.pendingRecycleTimers.clear();
    this.recyclingWorkerIds.clear();
  }

  /**
   * Cleanup resources for a worker that has exited.
   */
  cleanupWorker(workerId: number): void {
    this.workerStartTimes.delete(workerId);
    this.recyclingWorkerIds.delete(workerId);

    // Clean up any pending recycle timers for this worker
    const recycleTimer = this.pendingRecycleTimers.get(workerId);
    if (recycleTimer) {
      clearTimeout(recycleTimer);
      this.pendingRecycleTimers.delete(workerId);
    }

    this.metrics.activeWorkers = Math.max(0, this.metrics.activeWorkers - 1);
  }

  /**
   * Handle worker 'online' event.
   */
  private handleWorkerOnline(worker: Worker): void {
    this.log?.info("Worker online", { workerId: worker.id, pid: worker.process.pid });
    this.onWorkerOnlineCallback?.(worker);
  }

  /**
   * Handle worker 'exit' event.
   */
  private handleWorkerExit(worker: Worker, code: number | null, signal: string | null): void {
    this.cleanupWorker(worker.id);
    this.onWorkerExitCallback?.(worker, code, signal);
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    this.stopRecycling();

    if (this.clusterExitListener) {
      this.clusterRef.off("exit", this.clusterExitListener);
      this.clusterExitListener = undefined;
    }

    if (this.clusterOnlineListener) {
      this.clusterRef.off("online", this.clusterOnlineListener);
      this.clusterOnlineListener = undefined;
    }

    this.onWorkerOnlineCallback = undefined;
    this.onWorkerExitCallback = undefined;
  }
}
