import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig, WorkerMetrics } from "../src/types";
import { WorkerManager } from "../src/worker-manager";
import { MockCluster } from "./helpers";

const config: ResolvedConfig = {
  logger: null,
  workers: { count: 1, env: { WORKER_ENV: "test" }, execArgv: ["--trace-warnings"], maxAgeMs: 0 },
  restart: {
    crashThreshold: 2,
    crashWindowMs: 1_000,
    backoffMs: 0,
    maxBackoffMs: 1_000,
    backoffMultiplier: 2,
    stabilityWindowMs: 0,
  },
  shutdown: {
    timeoutMs: 1_000,
    ackTimeoutMs: 500,
    messagePrefix: "__wm",
    sigtermDelayMs: 100,
    sigintDelayMs: 100,
  },
  clusterModule: undefined,
};

function makeMetrics(): WorkerMetrics {
  return { workerRestarts: 0, activeWorkers: 0, crashLoopBackoffs: 0, gracefulShutdowns: 0, forcedKills: 0 };
}

describe("WorkerManager", () => {
  afterEach(() => vi.restoreAllMocks());

  // ── forkWorker ───────────────────────────────────────────────────────────

  it("configures exec arguments once and tracks forked workers", () => {
    const cluster = new MockCluster();
    const workerMetrics = makeMetrics();
    const manager = new WorkerManager(cluster as never, config, null, workerMetrics, ["--enable-source-maps"]);

    const first = manager.forkWorker();
    manager.forkWorker();

    expect(cluster.setupPrimary).toHaveBeenCalledWith({ execArgv: ["--enable-source-maps", "--trace-warnings"] });
    expect(cluster.setupPrimary).toHaveBeenCalledTimes(1);
    expect(cluster.fork).toHaveBeenCalledWith({ WORKER_ENV: "test" });
    expect(manager.getActiveWorkers()).toEqual([first, cluster.workers[2]]);
    expect(workerMetrics.activeWorkers).toBe(2);
  });

  it("does not call setupPrimary when execArgv is undefined", () => {
    const cluster = new MockCluster();
    const cfg = { ...config, workers: { ...config.workers, execArgv: undefined } };
    const manager = new WorkerManager(cluster as never, cfg, null, makeMetrics(), []);

    manager.forkWorker();

    expect(cluster.setupPrimary).not.toHaveBeenCalled();
  });

  it("merges envOverlay on top of cfg.workers.env for this fork only", () => {
    const cluster = new MockCluster();
    const cfg = {
      ...config,
      workers: { count: 2, env: { BASE: "1", SHARED: "base" } as NodeJS.ProcessEnv, execArgv: undefined, maxAgeMs: 0 },
    };
    const manager = new WorkerManager(cluster as never, cfg, null, makeMetrics(), []);

    // Fork with overlay
    manager.forkWorker({ SHARED: "overlay", NEW: "2" });

    // Overlay merged on top of base env
    expect(cluster.fork).toHaveBeenCalledWith({ BASE: "1", SHARED: "overlay", NEW: "2" });

    // Subsequent fork without overlay uses original env (not mutated)
    manager.forkWorker();
    expect(cluster.fork).toHaveBeenLastCalledWith({ BASE: "1", SHARED: "base" });
  });

  // ── cleanupWorker ─────────────────────────────────────────────────────────

  // Fork resource exhaustion (EMFILE/ENOMEM) often surfaces as an async
  // 'error' event on the worker instead of a synchronous throw: without a
  // listener it would escape as an uncaught exception and kill the primary.
  it("attaches an error listener to freshly forked workers", () => {
    const cluster = new MockCluster();
    const manager = new WorkerManager(cluster as never, config, null, makeMetrics(), []);

    const worker = manager.forkWorker();

    expect(worker.listenerCount("error")).toBeGreaterThan(0);
    expect(() => worker.emit("error", new Error("Resource temporarily unavailable"))).not.toThrow();
  });

  it("cleans worker state when the cluster reports an exit", () => {
    const cluster = new MockCluster();
    const workerMetrics = makeMetrics();
    const manager = new WorkerManager(cluster as never, config, null, workerMetrics, []);
    const onExit = vi.fn();
    manager.setupEventHandlers(vi.fn(), onExit);
    const worker = manager.forkWorker();
    manager.markForRecycling(worker.id);

    cluster.simulateExit(cluster.workers[1], 0, null);

    expect(manager.getActiveWorkers()).toEqual([]);
    expect(workerMetrics.activeWorkers).toBe(0);
    expect(onExit).toHaveBeenCalledWith(worker, 0, null);
  });

  it("does not decrement activeWorkers below zero", () => {
    const cluster = new MockCluster();
    const workerMetrics = makeMetrics();
    const manager = new WorkerManager(cluster as never, config, null, workerMetrics, []);

    // Manually call cleanupWorker twice to test clamping
    manager.cleanupWorker(1);
    manager.cleanupWorker(1);

    expect(workerMetrics.activeWorkers).toBe(0);
  });

  // ── getWorkerAge ──────────────────────────────────────────────────────────

  it("returns 0 for an unknown worker id", () => {
    const cluster = new MockCluster();
    const manager = new WorkerManager(cluster as never, config, null, makeMetrics(), []);

    expect(manager.getWorkerAge(999)).toBe(0);
  });

  it("returns the age in milliseconds since fork", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const cluster = new MockCluster();
    const manager = new WorkerManager(cluster as never, config, null, makeMetrics(), []);
    manager.forkWorker();

    vi.advanceTimersByTime(5_000);

    expect(manager.getWorkerAge(1)).toBe(5_000);
    vi.useRealTimers();
  });

  // ── Recycling ─────────────────────────────────────────────────────────────

  describe("recycling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not start recycling when maxAgeMs is 0", () => {
      const cluster = new MockCluster();
      const cfg = { ...config, workers: { ...config.workers, maxAgeMs: 0 } };
      const manager = new WorkerManager(cluster as never, cfg, null, makeMetrics(), []);
      const onRecycle = vi.fn();

      manager.startRecycling(() => false, onRecycle);

      vi.advanceTimersByTime(120_000);
      expect(onRecycle).not.toHaveBeenCalled();
    });

    it("recycles aged workers and forks replacements", () => {
      const cluster = new MockCluster();
      const cfg = { ...config, workers: { ...config.workers, maxAgeMs: 30_000 } };
      const manager = new WorkerManager(cluster as never, cfg, null, makeMetrics(), []);
      manager.setupEventHandlers(vi.fn(), vi.fn());
      manager.forkWorker(); // worker id=1

      const onRecycle = vi.fn();
      manager.startRecycling(() => false, onRecycle);

      // Advance past the 60s interval; worker age (60_001) > maxAgeMs (30_000)
      vi.advanceTimersByTime(60_001);
      // The 60s interval fires, finds worker aged > 30_000, schedules it
      // Stagger is idx*30_000 = 0*30_000 = 0, so it fires on the next tick
      vi.advanceTimersByTime(1);

      expect(onRecycle).toHaveBeenCalledTimes(1);
      expect(onRecycle).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 2 }));
    });

    it("stagger timer by 30s per worker", () => {
      const cluster = new MockCluster();
      const cfg = { ...config, workers: { ...config.workers, maxAgeMs: 30_000 } };
      const manager = new WorkerManager(cluster as never, cfg, null, makeMetrics(), []);
      manager.setupEventHandlers(vi.fn(), vi.fn());
      manager.forkWorker(); // id=1
      manager.forkWorker(); // id=2

      const onRecycle = vi.fn();
      manager.startRecycling(() => false, onRecycle);

      vi.advanceTimersByTime(60_001);
      // First worker (idx=0) fires immediately (0ms stagger)
      vi.advanceTimersByTime(1);
      expect(onRecycle).toHaveBeenCalledTimes(1);

      // Second worker (idx=1) fires after 30_000ms stagger
      vi.advanceTimersByTime(29_997);
      expect(onRecycle).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(onRecycle).toHaveBeenCalledTimes(2);
    });

    it("skips recycling when worker is filtered out as dead by getActiveWorkers", () => {
      const cluster = new MockCluster();
      const cfg = { ...config, workers: { ...config.workers, maxAgeMs: 30_000 } };
      const manager = new WorkerManager(cluster as never, cfg, null, makeMetrics(), []);
      manager.setupEventHandlers(vi.fn(), vi.fn());
      manager.forkWorker(); // id=1

      const onRecycle = vi.fn();
      manager.startRecycling(() => false, onRecycle);

      // Kill the worker before the interval fires
      cluster.workers[1].exit(0);
      vi.advanceTimersByTime(60_001);
      vi.advanceTimersByTime(1);

      expect(onRecycle).not.toHaveBeenCalled();
    });

    it("skips recycling when shutdown is in progress", () => {
      const cluster = new MockCluster();
      const cfg = { ...config, workers: { ...config.workers, maxAgeMs: 30_000 } };
      const manager = new WorkerManager(cluster as never, cfg, null, makeMetrics(), []);
      manager.setupEventHandlers(vi.fn(), vi.fn());
      manager.forkWorker();

      const onRecycle = vi.fn();
      manager.startRecycling(() => true, onRecycle); // isShuttingDown = true

      vi.advanceTimersByTime(120_001);
      vi.advanceTimersByTime(1);

      expect(onRecycle).not.toHaveBeenCalled();
    });

    it("stopRecycling clears interval and pending timers", () => {
      const cluster = new MockCluster();
      const cfg = { ...config, workers: { ...config.workers, maxAgeMs: 30_000 } };
      const manager = new WorkerManager(cluster as never, cfg, null, makeMetrics(), []);
      manager.setupEventHandlers(vi.fn(), vi.fn());
      manager.forkWorker();
      manager.forkWorker();

      const onRecycle = vi.fn();
      manager.startRecycling(() => false, onRecycle);

      vi.advanceTimersByTime(60_001); // interval fires, schedules 2 recycles
      vi.advanceTimersByTime(1); // first worker fires

      manager.stopRecycling();

      vi.advanceTimersByTime(60_000); // second worker stagger would have fired
      expect(onRecycle).toHaveBeenCalledTimes(1); // only the first one
      expect(manager.getRecyclingCount()).toBe(0);
    });

    it("does not recycle a worker already marked for recycling", () => {
      const cluster = new MockCluster();
      const cfg = { ...config, workers: { ...config.workers, maxAgeMs: 30_000 } };
      const manager = new WorkerManager(cluster as never, cfg, null, makeMetrics(), []);
      manager.setupEventHandlers(vi.fn(), vi.fn());
      manager.forkWorker(); // id=1

      manager.markForRecycling(1);
      const onRecycle = vi.fn();
      manager.startRecycling(() => false, onRecycle);

      vi.advanceTimersByTime(120_001);
      vi.advanceTimersByTime(1);

      expect(onRecycle).not.toHaveBeenCalled(); // already marked, skipped
    });

    // A failed recycle fork (EMFILE/ENOMEM...) must not leak a stale
    // recycling mark: the worker stays eligible for the next sweep.
    it("unmarks the worker and skips the recycle when the replacement fork throws", () => {
      const cluster = new MockCluster();
      const cfg = { ...config, workers: { ...config.workers, maxAgeMs: 30_000 } };
      const manager = new WorkerManager(cluster as never, cfg, null, makeMetrics(), []);
      manager.setupEventHandlers(vi.fn(), vi.fn());
      manager.forkWorker(); // id=1

      const forkSpy = vi.spyOn(cluster, "fork").mockImplementation(() => {
        throw new Error("EMFILE: too many open files");
      });
      const onRecycle = vi.fn();
      manager.startRecycling(() => false, onRecycle);

      vi.advanceTimersByTime(60_001);
      vi.advanceTimersByTime(1);

      expect(onRecycle).not.toHaveBeenCalled();
      expect(manager.getRecyclingCount()).toBe(0);

      // The worker is eligible again: the next sweep retries the recycle
      forkSpy.mockRestore();
      vi.advanceTimersByTime(60_001);
      vi.advanceTimersByTime(1);
      expect(onRecycle).toHaveBeenCalledTimes(1);
    });
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  it("removes cluster listeners on dispose", () => {
    const cluster = new MockCluster();
    const manager = new WorkerManager(cluster as never, config, null, makeMetrics(), []);
    manager.setupEventHandlers(vi.fn(), vi.fn());

    expect(cluster.listenerCount("exit")).toBe(1);
    expect(cluster.listenerCount("online")).toBe(1);

    manager.dispose();

    expect(cluster.listenerCount("exit")).toBe(0);
    expect(cluster.listenerCount("online")).toBe(0);
  });
});
