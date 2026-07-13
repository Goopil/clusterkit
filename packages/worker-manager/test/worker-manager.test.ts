import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig, WorkerMetrics } from "../src/types";
import { WorkerManager } from "../src/worker-manager";

class MockWorker extends EventEmitter {
  readonly process = { pid: 1_000 };
  private dead = false;

  constructor(readonly id: number) {
    super();
  }

  isDead(): boolean {
    return this.dead;
  }

  exit(): void {
    this.dead = true;
    this.emit("exit", 0, null);
  }
}

class MockCluster extends EventEmitter {
  workers: Record<number, MockWorker> = {};
  readonly setupPrimary = vi.fn();
  private nextId = 1;
  readonly fork = vi.fn(() => {
    const worker = new MockWorker(this.nextId++);
    this.workers[worker.id] = worker;
    return worker;
  });
}

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

function metrics(): WorkerMetrics {
  return { workerRestarts: 0, activeWorkers: 0, crashLoopBackoffs: 0, gracefulShutdowns: 0, forcedKills: 0 };
}

afterEach(() => vi.restoreAllMocks());

describe("WorkerManager", () => {
  it("configures exec arguments once and tracks forked workers", () => {
    const cluster = new MockCluster();
    const workerMetrics = metrics();
    const manager = new WorkerManager(cluster as never, config, null, workerMetrics, ["--enable-source-maps"]);

    const first = manager.forkWorker();
    manager.forkWorker();

    expect(cluster.setupPrimary).toHaveBeenCalledWith({ execArgv: ["--enable-source-maps", "--trace-warnings"] });
    expect(cluster.setupPrimary).toHaveBeenCalledTimes(1);
    expect(cluster.fork).toHaveBeenCalledWith({ WORKER_ENV: "test" });
    expect(manager.getActiveWorkers()).toEqual([first, cluster.workers[2]]);
    expect(workerMetrics.activeWorkers).toBe(2);
  });

  it("cleans worker state when the cluster reports an exit", () => {
    const cluster = new MockCluster();
    const workerMetrics = metrics();
    const manager = new WorkerManager(cluster as never, config, null, workerMetrics, []);
    const onExit = vi.fn();
    manager.setupEventHandlers(vi.fn(), onExit);
    const worker = manager.forkWorker();
    manager.markForRecycling(worker.id);

    worker.exit();
    cluster.emit("exit", worker, 0, null);

    expect(manager.getActiveWorkers()).toEqual([]);
    expect(manager.isMarkedForRecycling(worker.id)).toBe(false);
    expect(workerMetrics.activeWorkers).toBe(0);
    expect(onExit).toHaveBeenCalledWith(worker, 0, null);
  });
});
