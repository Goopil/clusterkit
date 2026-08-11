import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShutdownCoordinator } from "../src/shutdown-coordinator";
import type { ResolvedConfig, WorkerMetrics } from "../src/types";
import { MockWorker } from "./helpers/mock-worker";

// Stubborn worker — never ACKs, never exits on its own.
class StubbornWorker extends EventEmitter {
  readonly id: number;
  readonly process = {
    pid: 1,
    kill: vi.fn((signal?: string) => {
      if (signal === "SIGKILL") {
        this.dead = true;
        this.emit("exit", 1, signal);
      }
      return true;
    }),
  };
  dead = false;
  connected = true;
  readonly send = vi.fn(() => true);

  constructor(id: number) {
    super();
    this.id = id;
  }

  isDead() {
    return this.dead;
  }

  isConnected() {
    return this.connected;
  }

  disconnect() {
    this.connected = false;
  }
}

const baseConfig: ResolvedConfig = {
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

function makeMetrics(): WorkerMetrics {
  return { workerRestarts: 0, activeWorkers: 1, crashLoopBackoffs: 0, gracefulShutdowns: 0, forcedKills: 0 };
}

describe("ShutdownCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Happy path (existing) ──────────────────────────────────────────────

  it("acknowledges workers, disconnects them, and reports completion", async () => {
    const metrics = makeMetrics();
    const coordinator = new ShutdownCoordinator(baseConfig, null, metrics, "app");
    const onStart = vi.fn();
    const onComplete = vi.fn();
    coordinator.setupCallbacks(onStart, onComplete);
    const worker = new MockWorker(1, { autoAck: true, messagePrefix: "app" });

    await coordinator.initiateShutdown([worker as never], "SIGTERM");

    expect(worker.send).toHaveBeenCalledWith({ type: "app:shutdown" });
    expect(worker.isDead()).toBe(true);
    expect(onStart).toHaveBeenCalledWith("SIGTERM");
    expect(onComplete).toHaveBeenCalledWith(metrics);
    expect(coordinator.isShutdownInProgress()).toBe(true);
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it("does not run shutdown twice when initiateShutdown is called again", async () => {
    const metrics = makeMetrics();
    const coordinator = new ShutdownCoordinator(baseConfig, null, metrics, "app");
    const onStart = vi.fn();
    coordinator.setupCallbacks(onStart, vi.fn());
    const worker = new MockWorker(1, { autoAck: true, messagePrefix: "app" });

    await coordinator.initiateShutdown([worker as never], "SIGTERM");
    onStart.mockClear();
    await coordinator.initiateShutdown([worker as never], "SIGTERM");

    expect(onStart).not.toHaveBeenCalled();
  });

  // ── ACK timeout ──────────────────────────────────────────────────────────

  it("disconnects and warns when worker does not ACK within ackTimeoutMs", async () => {
    const warnSpy = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() };
    const coordinator = new ShutdownCoordinator(baseConfig, log, makeMetrics(), "app");
    coordinator.setupCallbacks(vi.fn(), vi.fn());
    const worker = new MockWorker(1);

    const promise = coordinator.initiateShutdown([worker as never], "SIGTERM");
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(worker.send).toHaveBeenCalledWith({ type: "app:shutdown" });
    expect(warnSpy).toHaveBeenCalledWith("Worker ACK timeout", expect.objectContaining({ workerId: 1 }));
    expect(worker.isConnected()).toBe(false);
  });

  // ── Worker already dead ──────────────────────────────────────────────────

  it("resolves immediately when worker is already dead", async () => {
    const coordinator = new ShutdownCoordinator(baseConfig, null, makeMetrics(), "app");
    coordinator.setupCallbacks(vi.fn(), vi.fn());
    const worker = new MockWorker(1);
    worker.exit(0);

    await coordinator.initiateShutdown([worker as never], "SIGTERM");

    expect(worker.send).not.toHaveBeenCalled();
  });

  it("skips sending shutdown message when worker is already disconnected", async () => {
    const coordinator = new ShutdownCoordinator(baseConfig, null, makeMetrics(), "app");
    coordinator.setupCallbacks(vi.fn(), vi.fn());
    const worker = new MockWorker(1);
    worker.connected = false;

    const promise = coordinator.initiateShutdown([worker as never], "SIGTERM");
    // Worker is disconnected but not dead — coordinator waits for exit timeout,
    // then escalates SIGTERM → SIGINT → SIGKILL to force the worker to die.
    await vi.advanceTimersByTimeAsync(1200);
    await promise;

    expect(worker.send).not.toHaveBeenCalled();
  });

  // ── worker.send() throws ──────────────────────────────────────────────────

  it("disconnects and resolves when worker.send() throws", async () => {
    const coordinator = new ShutdownCoordinator(baseConfig, null, makeMetrics(), "app");
    coordinator.setupCallbacks(vi.fn(), vi.fn());
    const worker = new MockWorker(1);
    worker.send.mockImplementation(() => {
      throw new Error("IPC channel closed");
    });

    await coordinator.initiateShutdown([worker as never], "SIGTERM");

    expect(worker.isConnected()).toBe(false);
  });

  // ── SIGTERM → SIGINT → SIGKILL escalation ─────────────────────────────────

  it("escalates from SIGTERM to SIGINT to SIGKILL when worker refuses to die", async () => {
    const metrics = makeMetrics();
    const coordinator = new ShutdownCoordinator(baseConfig, null, metrics, "app");
    coordinator.setupCallbacks(vi.fn(), vi.fn());
    const worker = new StubbornWorker(1);

    const promise = coordinator.initiateShutdown([worker as never], "SIGTERM");
    // Advance through ACK timeout (500ms) — exactly, to avoid overshooting into kill delay
    await vi.advanceTimersByTimeAsync(500);
    // Advance through waitForWorkersToExit timeout (1000ms)
    await vi.advanceTimersByTimeAsync(1000);
    // killWorkerGradually starts: SIGTERM sent immediately, then waits sigtermDelayMs (100ms)
    expect(worker.process.kill).toHaveBeenLastCalledWith("SIGTERM");
    // Advance sigtermDelay → SIGINT sent, then waits sigintDelayMs (100ms)
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.process.kill).toHaveBeenLastCalledWith("SIGINT");
    // Advance sigintDelay → SIGKILL sent
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.process.kill).toHaveBeenLastCalledWith("SIGKILL");
    expect(metrics.forcedKills).toBe(1);

    await promise;
  });

  // ── Multiple workers ──────────────────────────────────────────────────────

  it("handles mixed workers: one ACKs, one times out, one already dead", async () => {
    const metrics = makeMetrics();
    metrics.activeWorkers = 3;
    const coordinator = new ShutdownCoordinator(baseConfig, null, metrics, "app");
    coordinator.setupCallbacks(vi.fn(), vi.fn());

    const w1 = new MockWorker(1, { autoAck: true, messagePrefix: "app" });
    const w2 = new MockWorker(2); // no auto-ack → will timeout
    const w3 = new MockWorker(3);
    w3.exit(0); // already dead

    const promise = coordinator.initiateShutdown([w1, w2, w3] as never, "SIGTERM");
    await vi.advanceTimersByTimeAsync(600);
    await promise;

    expect(w1.isDead()).toBe(true); // ACKed → disconnected
    expect(w2.isConnected()).toBe(false); // timed out → disconnected
    expect(w3.send).not.toHaveBeenCalled(); // was already dead
  });

  // ── Worker exits before ACK ───────────────────────────────────────────────

  it("resolves ACK wait when worker exits before sending ack", async () => {
    const coordinator = new ShutdownCoordinator(baseConfig, null, makeMetrics(), "app");
    coordinator.setupCallbacks(vi.fn(), vi.fn());
    const worker = new MockWorker(1);

    const promise = coordinator.initiateShutdown([worker as never], "SIGTERM");
    // Worker exits before the ACK timeout
    worker.exit(0);
    await promise;

    expect(coordinator.isShutdownInProgress()).toBe(true);
  });
});
