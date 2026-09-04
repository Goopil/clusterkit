import type { Worker } from "node:cluster";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrashTracker } from "../src/crash-tracker";
import type { RestartQueueEntry } from "../src/restart-coordinator";
import { MAX_CONSECUTIVE_FORK_FAILURES, RestartCoordinator } from "../src/restart-coordinator";
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
    messagePrefix: "__rc",
    sigtermDelayMs: 100,
    sigintDelayMs: 100,
  },
  clusterModule: undefined,
};

function makeMetrics(): WorkerMetrics {
  return { workerRestarts: 0, activeWorkers: 0, crashLoopBackoffs: 0, gracefulShutdowns: 0, forcedKills: 0 };
}

interface Harness {
  coordinator: RestartCoordinator;
  metrics: WorkerMetrics;
  crashTracker: CrashTracker;
  fork: ReturnType<typeof vi.fn>;
  restarts: MockWorker[];
  breakerTrips: Array<{ crashCount: number; windowMs: number }>;
  isShuttingDown: ReturnType<typeof vi.fn>;
}

/**
 * Mirrors the real wiring: WorkerManager.forkWorker() increments
 * activeWorkers at fork time and decrements it on worker exit, so the
 * harness does the same around the coordinator calls.
 */
function makeCoordinator(
  overrides: {
    restart?: Partial<ResolvedConfig["restart"]>;
    target?: number;
    recycling?: number;
    forkImpl?: () => MockWorker;
  } = {},
): Harness {
  const metrics = makeMetrics();
  const nextWorkerId = { value: 1 };
  const crashTracker = new CrashTracker(
    overrides.restart?.crashThreshold ?? config.restart.crashThreshold,
    overrides.restart?.crashWindowMs ?? config.restart.crashWindowMs,
  );
  const restarts: MockWorker[] = [];
  const breakerTrips: Array<{ crashCount: number; windowMs: number }> = [];
  const isShuttingDown = vi.fn(() => false);
  const fork = vi.fn(
    overrides.forkImpl ??
      (() => {
        metrics.activeWorkers++;
        return new MockWorker(nextWorkerId.value++);
      }),
  );
  const coordinator = new RestartCoordinator(
    { ...config, restart: { ...config.restart, ...(overrides.restart ?? {}) } },
    null,
    metrics,
    crashTracker,
    {
      forkWorker: fork as unknown as () => Worker,
      isShuttingDown,
      targetWorkerCount: vi.fn(() => overrides.target ?? 2),
      recyclingCount: vi.fn(() => overrides.recycling ?? 0),
      onRestarted: (w) => restarts.push(w as MockWorker),
      onBreakerTripped: (info) => breakerTrips.push(info),
    },
  );
  return { coordinator, metrics, crashTracker, fork, restarts, breakerTrips, isShuttingDown };
}

/** Simulate an unclean crash: WorkerManager already removed the worker. */
function crash(h: Harness, workerId: number): void {
  h.metrics.activeWorkers = Math.max(0, h.metrics.activeWorkers - 1);
  h.coordinator.onWorkerCrash(workerId, 1, null);
}

let savedExitCode: typeof process.exitCode;

beforeEach(() => {
  savedExitCode = process.exitCode;
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
});

describe("RestartCoordinator", () => {
  describe("crash → restart", () => {
    it("restarts a crashed worker by forking a replacement", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator();
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.fork).toHaveBeenCalledTimes(1);
      expect(h.metrics.workerRestarts).toBe(1);
      expect(h.restarts).toHaveLength(1);
    });

    it("restarts every queued crash until capacity is met", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ target: 3 });
      h.metrics.activeWorkers = 3;

      crash(h, 1);
      crash(h, 2);
      crash(h, 3);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.metrics.workerRestarts).toBe(3);
      expect(h.restarts).toHaveLength(3);
    });

    it("processes the restart queue in FIFO order (first crash restarted first)", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ target: 3 });
      h.metrics.activeWorkers = 3;

      // swapping shift() → pop() (FIFO → LIFO) passed CI historically —
      // restart order was never asserted by workerId. The spy below keeps
      // that regression covered at the unit level.
      const spy = vi.spyOn(
        h.coordinator as unknown as {
          restartWorkerWithBackoff: (entry: RestartQueueEntry) => Promise<void>;
        },
        "restartWorkerWithBackoff",
      );

      crash(h, 1);
      crash(h, 2);
      crash(h, 3);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.metrics.workerRestarts).toBe(3);
      expect(spy.mock.calls.map((call) => (call[0] as { workerId: number }).workerId)).toEqual([1, 2, 3]);
    });

    it("skips stale queued restarts when capacity is already met", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ target: 2 });
      h.metrics.activeWorkers = 2;

      // A stale entry (worker id no longer maps to missing capacity): the
      // queue loop must drop it without forking.
      (h.coordinator as unknown as { pendingRestartQueue: RestartQueueEntry[] }).pendingRestartQueue.push({
        kind: "crash",
        workerId: 999,
        code: 1,
        signal: null,
      });

      await (h.coordinator as unknown as { processRestartQueue: () => Promise<void> }).processRestartQueue();

      expect(h.fork).not.toHaveBeenCalled();
      expect(h.metrics.workerRestarts).toBe(0);
    });

    it("accounts for workers being recycled in the capacity math", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ target: 2, recycling: 1 });
      // active 3 = 2 healthy + 1 recycling-but-alive: the crash below must
      // still be restarted even though activeWorkers >= target.
      h.metrics.activeWorkers = 3;

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.metrics.workerRestarts).toBe(1);
    });
  });

  describe("backoff", () => {
    it("restarts the first crash after backoffMs and the next after backoffMs * multiplier", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 1_000, backoffMultiplier: 2 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(999);
      expect(h.fork).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.fork).toHaveBeenCalledTimes(1);

      crash(h, 3);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(h.fork).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.fork).toHaveBeenCalledTimes(2);
    });

    it("does not fork a replacement when shutdown starts during backoff", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 1_000 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      h.isShuttingDown.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(h.fork).not.toHaveBeenCalled();
      expect(h.metrics.workerRestarts).toBe(0);
    });

    it("resets backoff after the stability window elapses", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 1_000, backoffMultiplier: 4, stabilityWindowMs: 5_000 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(1_000); // first restart (backoff → 4s)
      const restarted = h.restarts[0];

      // Replacement comes online → schedules the backoff reset
      h.coordinator.onWorkerOnline(restarted.id);
      await vi.advanceTimersByTimeAsync(5_000); // stability window elapses → backoff → 0

      crash(h, restarted.id);
      await vi.advanceTimersByTimeAsync(1_000); // base backoff again, not 4s
      expect(h.fork).toHaveBeenCalledTimes(2);
    });

    it("does not reset backoff when the fleet is not stable during the window", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 1_000, backoffMultiplier: 4, stabilityWindowMs: 5_000 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(1_000); // first restart (backoff → 4s)
      const restarted = h.restarts[0];

      // Replacement comes online → schedules the backoff reset
      h.coordinator.onWorkerOnline(restarted.id);
      await vi.advanceTimersByTimeAsync(4_999); // 1ms before the window elapses

      // A crash before the window elapses breaks stability — mirrors
      // Orchestrator.handleWorkerExit's unclean-exit path.
      h.coordinator.cancelBackoffReset();
      crash(h, restarted.id);

      await vi.advanceTimersByTimeAsync(3_999); // elevated 4s backoff, not the 1s base
      expect(h.fork).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.fork).toHaveBeenCalledTimes(2);
    });

    it("resets restart backoff immediately when stabilityWindowMs is 0", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 1_000, backoffMultiplier: 4, stabilityWindowMs: 0 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(1_000);
      const restarted = h.restarts[0];

      h.coordinator.onWorkerOnline(restarted.id);

      crash(h, restarted.id);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.fork).toHaveBeenCalledTimes(2);
    });

    it("unrefs the crash-restart backoff timer", () => {
      const unrefSpy = vi.fn();
      const nativeSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        handler: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        const timer = nativeSetTimeout(handler, delay, ...args) as NodeJS.Timeout;
        const originalUnref = timer.unref.bind(timer);
        timer.unref = () => {
          unrefSpy();
          return originalUnref();
        };
        return timer;
      }) as typeof setTimeout);

      const h = makeCoordinator({ restart: { backoffMs: 5_000 } });
      h.metrics.activeWorkers = 2;

      // Crash one worker: the restart loop schedules (and must unref) the
      // 5s backoff timer synchronously within the spied window.
      crash(h, 1);

      const backoffCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5_000);
      expect(backoffCallIndex).toBeGreaterThanOrEqual(0);
      expect(unrefSpy).toHaveBeenCalledTimes(1);

      // Do not let the pending backoff timer outlive the test.
      clearTimeout(setTimeoutSpy.mock.results[backoffCallIndex].value as NodeJS.Timeout);
      vi.restoreAllMocks();
    });
  });

  describe("fork failure resilience", () => {
    it("re-queues a restart when fork throws and restores capacity on the retry", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 100 } });
      h.metrics.activeWorkers = 2;
      h.fork.mockImplementationOnce(() => {
        throw new Error("Resource temporarily unavailable");
      });

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(100); // first attempt fails
      expect(h.fork).toHaveBeenCalledTimes(1);
      expect(h.metrics.workerRestarts).toBe(0);

      await vi.advanceTimersByTimeAsync(100); // re-queued entry retried
      expect(h.fork).toHaveBeenCalledTimes(2);
      expect(h.metrics.workerRestarts).toBe(1);
    });

    it(`gives up after ${MAX_CONSECUTIVE_FORK_FAILURES} consecutive fork failures and flags exit code 1`, async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 0 } });
      h.metrics.activeWorkers = 2;
      h.fork.mockImplementation(() => {
        throw new Error("Resource temporarily unavailable");
      });

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(process.exitCode).toBe(1);
      // Queue cleared: no further fork attempts
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.fork).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FORK_FAILURES);
    });

    it("refill entries log a capacity refill instead of a fake crash report", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ target: 2 });
      h.metrics.activeWorkers = 1;

      h.coordinator.requestCapacityRefill(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.metrics.workerRestarts).toBe(1);
      expect(h.restarts).toHaveLength(1);
    });
  });

  describe("circuit breaker reactions", () => {
    it("trips, warns once, counts backoffs and signals onBreakerTripped", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { crashThreshold: 2, crashWindowMs: 60_000 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1); // below threshold: a replacement is forked
      await vi.advanceTimersByTimeAsync(0);
      expect(h.metrics.workerRestarts).toBe(1);

      crash(h, 3); // trips the breaker
      await vi.advanceTimersByTimeAsync(1_000);

      expect(h.breakerTrips).toEqual([{ crashCount: 2, windowMs: 60_000 }]);
      expect(h.metrics.crashLoopBackoffs).toBe(1);
      expect(process.emitWarning).toHaveBeenCalledTimes(1);
      expect(process.emitWarning).toHaveBeenCalledWith(expect.stringContaining("Crash loop"), "ClusterKitCrashLoop");
      expect(h.fork).toHaveBeenCalledTimes(1); // no fork past the trip
    });

    it("drops queued restarts once the breaker has tripped", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { crashThreshold: 2, backoffMs: 100 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1); // queued, backoff pending
      crash(h, 3); // trips the breaker
      await vi.advanceTimersByTimeAsync(1_000);

      expect(h.fork).not.toHaveBeenCalled();
      expect(h.metrics.workerRestarts).toBe(0);
    });

    it("warns again if the breaker trips a second time after a reset", () => {
      const h = makeCoordinator({ restart: { crashThreshold: 2 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      crash(h, 3);
      expect(process.emitWarning).toHaveBeenCalledTimes(1);

      h.coordinator.reset();
      crash(h, 5);
      crash(h, 7);
      expect(process.emitWarning).toHaveBeenCalledTimes(2);
    });
  });

  describe("shared fork-failure counter (hot restart roll)", () => {
    it("notes failures/successes and flags an unrecoverable env at the limit", () => {
      const h = makeCoordinator();

      expect(h.coordinator.noteForkFailure()).toBe(1);
      expect(h.coordinator.isForkEnvUnrecoverable()).toBe(false);
      expect(h.coordinator.noteForkFailure()).toBe(2);
      expect(h.coordinator.noteForkFailure()).toBe(3);
      expect(h.coordinator.isForkEnvUnrecoverable()).toBe(true);

      h.coordinator.noteForkSuccess();
      expect(h.coordinator.isForkEnvUnrecoverable()).toBe(false);
    });

    it("reset() clears the tracker, backoff and fork-failure counter", () => {
      const h = makeCoordinator({ restart: { crashThreshold: 2 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      crash(h, 3);
      expect(h.crashTracker.isTripped()).toBe(true);

      h.coordinator.reset();
      expect(h.crashTracker.isTripped()).toBe(false);
      expect(h.coordinator.isForkEnvUnrecoverable()).toBe(false);
    });
  });
});
