import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrainCoordinator } from "../src/drain-coordinator";
import type { ResolvedConfig, WorkerMetrics } from "../src/types";
import { MockWorker } from "./helpers";

const config: ResolvedConfig = {
  logger: null,
  workers: { count: 2, env: undefined, execArgv: undefined, maxAgeMs: 0 },
  restart: {
    crashThreshold: 5,
    crashWindowMs: 60_000,
    backoffMs: 0,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2,
    stabilityWindowMs: 0,
  },
  shutdown: {
    timeoutMs: 1_000,
    ackTimeoutMs: 500,
    messagePrefix: "__dc",
    sigtermDelayMs: 300,
    sigintDelayMs: 200,
  },
  clusterModule: undefined,
};

function makeMetrics(): WorkerMetrics {
  return { workerRestarts: 0, activeWorkers: 0, crashLoopBackoffs: 0, gracefulShutdowns: 0, forcedKills: 0 };
}

function makeDrainer(overrides: { isShuttingDown?: () => boolean } = {}) {
  const metrics = makeMetrics();
  const drainer = new DrainCoordinator({ ...config }, null, metrics, {
    isShuttingDown: overrides.isShuttingDown ?? (() => false),
  });
  return { drainer, metrics };
}

/** Old worker that survives disconnect so the escalation path is exercised. */
function stuckWorker(id: number): MockWorker {
  return new MockWorker(id, { deadOnDisconnect: false });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-12T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DrainCoordinator", () => {
  it("sends the shutdown message and disconnects the old worker once the replacement is online", () => {
    const { drainer } = makeDrainer();
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2);

    drainer.recycle(oldWorker, newWorker);
    newWorker.emit("online");

    expect(oldWorker.send).toHaveBeenCalledWith({ type: "__dc:shutdown" }, expect.any(Function));
    expect(oldWorker.disconnect).toHaveBeenCalledTimes(1);
  });

  it("drains the old worker when the replacement dies before coming online", () => {
    const { drainer } = makeDrainer();
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2, { deadOnDisconnect: false });

    drainer.recycle(oldWorker, newWorker);
    newWorker.emit("exit", 1, null);

    expect(oldWorker.disconnect).toHaveBeenCalledTimes(1);
  });

  it("escalates SIGTERM at shutdown.timeoutMs then SIGKILL after sigtermDelayMs + sigintDelayMs", async () => {
    const { metrics, drainer } = makeDrainer();
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2);

    drainer.recycle(oldWorker, newWorker);
    newWorker.emit("online"); // arms the drain
    await vi.advanceTimersByTimeAsync(0);

    // SIGTERM at shutdown.timeoutMs (1s here)
    await vi.advanceTimersByTimeAsync(999);
    expect(oldWorker.process.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(oldWorker.process.kill).toHaveBeenCalledWith("SIGTERM");

    // SIGKILL after sigtermDelayMs + sigintDelayMs more (500ms here)
    await vi.advanceTimersByTimeAsync(498);
    expect(oldWorker.process.kill).not.toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(2);
    expect(oldWorker.process.kill).toHaveBeenCalledWith("SIGKILL");
    expect(metrics.forcedKills).toBe(1);
  });

  it("does not SIGTERM a stuck recycled worker once shutdown has started", async () => {
    let shuttingDown = false;
    const { metrics, drainer } = makeDrainer({ isShuttingDown: () => shuttingDown });
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2);

    drainer.recycle(oldWorker, newWorker);
    newWorker.emit("online"); // drain arms before the test starts the shutdown
    await vi.advanceTimersByTimeAsync(0);
    expect(oldWorker.isConnected()).toBe(false); // drained (shutdown message + disconnect)
    expect(oldWorker.isDead()).toBe(false); // stuck

    // Shutdown starts BEFORE the SIGTERM escalation (timeoutMs) fires
    shuttingDown = true;
    await vi.advanceTimersByTimeAsync(1_002);
    expect(oldWorker.process.kill).not.toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(501);
    expect(oldWorker.process.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(metrics.forcedKills).toBe(0);
  });

  it("does not SIGKILL once shutdown has started after SIGTERM", async () => {
    let shuttingDown = false;
    const { metrics, drainer } = makeDrainer({ isShuttingDown: () => shuttingDown });
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2);

    drainer.recycle(oldWorker, newWorker);
    newWorker.emit("online");
    await vi.advanceTimersByTimeAsync(0);

    // SIGTERM fires before shutdown: escalation fully armed, SIGKILL pending
    await vi.advanceTimersByTimeAsync(1_002);
    expect(oldWorker.process.kill).toHaveBeenCalledWith("SIGTERM");

    // Shutdown starts in the SIGKILL window (sigtermDelayMs + sigintDelayMs)
    shuttingDown = true;
    await vi.advanceTimersByTimeAsync(502);
    expect(oldWorker.process.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(metrics.forcedKills).toBe(0);
  });

  it("drains the old worker when the replacement never comes online (failsafe)", async () => {
    const { drainer } = makeDrainer();
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2, { deadOnDisconnect: false }); // never online, never exits

    drainer.recycle(oldWorker, newWorker);

    // Failsafe budget = timeoutMs + sigtermDelayMs + sigintDelayMs + 5s = 6.5s
    await vi.advanceTimersByTimeAsync(6_499);
    expect(oldWorker.isConnected()).toBe(true);

    await vi.advanceTimersByTimeAsync(2);
    expect(oldWorker.isConnected()).toBe(false); // drained
    expect(oldWorker.disconnect).toHaveBeenCalledTimes(1); // exactly once — no double drain
  });

  it("skips the failsafe when shutdown is in progress", async () => {
    const { drainer } = makeDrainer({ isShuttingDown: () => true });
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2, { deadOnDisconnect: false });

    drainer.recycle(oldWorker, newWorker);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(oldWorker.isConnected()).toBe(true);
  });
});
