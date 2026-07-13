import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ShutdownCoordinator } from "../src/shutdown-coordinator";
import type { ResolvedConfig, WorkerMetrics } from "../src/types";

class MockWorker extends EventEmitter {
  readonly process = { kill: vi.fn() };
  private dead = false;
  private connected = true;
  readonly send = vi.fn((message: { type: string }) => {
    queueMicrotask(() => this.emit("message", { type: message.type.replace(":shutdown", ":shutdown-ack") }));
    return true;
  });

  constructor(readonly id: number) {
    super();
  }

  isDead(): boolean {
    return this.dead;
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    this.connected = false;
    this.dead = true;
    this.emit("disconnect");
    this.emit("exit", 0, null);
  }
}

const config: ResolvedConfig = {
  logger: null,
  workers: { count: 1, env: undefined, execArgv: undefined, maxAgeMs: 0 },
  restart: {
    crashThreshold: 2,
    crashWindowMs: 1_000,
    backoffMs: 0,
    maxBackoffMs: 1_000,
    backoffMultiplier: 2,
    stabilityWindowMs: 0,
  },
  shutdown: { timeoutMs: 1_000, ackTimeoutMs: 500, messagePrefix: "app", sigtermDelayMs: 100, sigintDelayMs: 100 },
  clusterModule: undefined,
};

describe("ShutdownCoordinator", () => {
  it("acknowledges workers, disconnects them, and reports completion", async () => {
    const metrics: WorkerMetrics = {
      workerRestarts: 0,
      activeWorkers: 1,
      crashLoopBackoffs: 0,
      gracefulShutdowns: 0,
      forcedKills: 0,
    };
    const coordinator = new ShutdownCoordinator(config, null, metrics, "app");
    const onStart = vi.fn();
    const onComplete = vi.fn();
    coordinator.setupCallbacks(onStart, onComplete);
    const worker = new MockWorker(1);

    await coordinator.initiateShutdown([worker] as never, "SIGTERM");

    expect(worker.send).toHaveBeenCalledWith({ type: "app:shutdown" });
    expect(worker.isDead()).toBe(true);
    expect(onStart).toHaveBeenCalledWith("SIGTERM");
    expect(onComplete).toHaveBeenCalledWith(metrics);
    expect(coordinator.isShutdownInProgress()).toBe(true);
  });
});
