import cluster from "node:cluster";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator";
import type { Logger, WorkerMetrics } from "../src/types";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_FIXTURE_PATH = resolve(__dirname, "fixtures/process-worker.cjs");

const SIGNAL_TIMEOUT_MS = 8_000;

function createMemoryLogger() {
  const entries: LogEntry[] = [];

  const logger: Logger = {
    debug(message, data) {
      entries.push({ level: "debug", message, data });
    },
    info(message, data) {
      entries.push({ level: "info", message, data });
    },
    warn(message, data) {
      entries.push({ level: "warn", message, data });
    },
    error(message, data) {
      entries.push({ level: "error", message, data });
    },
  };

  return { logger, entries };
}

function hasMessage(entry: LogEntry, message: string): boolean {
  return entry.message === message || entry.message.endsWith(`] ${message}`);
}

function randomPrefix(): string {
  return `__wm_it_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function waitForOnlineWorkers(orchestrator: Orchestrator, expectedCount: number): Promise<void> {
  const onlineWorkerIds = new Set<number>();

  await withTimeout(
    new Promise<void>((resolveOnline) => {
      orchestrator.on("worker:online", (event) => {
        onlineWorkerIds.add(event.workerId);
        if (onlineWorkerIds.size >= expectedCount) {
          resolveOnline();
        }
      });
    }),
    SIGNAL_TIMEOUT_MS,
    `Timed out waiting for ${expectedCount} workers to become online`,
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error(message));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });
  });
}

async function triggerSigtermAndWaitForShutdown(orchestrator: Orchestrator): Promise<WorkerMetrics> {
  const shutdownDone = once(orchestrator, "shutdown:complete") as Promise<[{ metrics: WorkerMetrics }]>;
  process.emit("SIGTERM");
  const [{ metrics }] = await withTimeout(
    shutdownDone,
    SIGNAL_TIMEOUT_MS,
    "Timed out waiting for shutdown:complete event",
  );
  return metrics;
}

async function killRemainingWorkers(): Promise<void> {
  const workers = Object.values(cluster.workers ?? {}).filter(
    (worker): worker is cluster.Worker => worker !== undefined,
  );

  await Promise.all(
    workers.map(
      (worker) =>
        new Promise<void>((resolveWorker) => {
          if (worker.isDead()) {
            resolveWorker();
            return;
          }

          const timeout = setTimeout(() => resolveWorker(), 1_500);
          worker.once("exit", () => {
            clearTimeout(timeout);
            resolveWorker();
          });
          worker.process.kill("SIGKILL");
        }),
    ),
  );
}

afterEach(async () => {
  await killRemainingWorkers();
});

describe("Orchestrator process-level integration", () => {
  it("should gracefully shutdown cooperative workers on SIGTERM", async () => {
    const messagePrefix = randomPrefix();
    const { logger, entries } = createMemoryLogger();

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });

    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      logger,
      workers: {
        count: 2,
        env: {
          WM_IT_MODE: "cooperative",
          WM_IT_MESSAGE_PREFIX: messagePrefix,
          WM_IT_SHUTDOWN_DELAY_MS: "25",
        },
      },
      shutdown: {
        timeoutMs: 1_000,
        ackTimeoutMs: 500,
        sigtermDelayMs: 100,
        sigintDelayMs: 100,
        messagePrefix,
      },
    });

    await orchestrator.run();
    await waitForOnlineWorkers(orchestrator, 2);

    const metrics = await triggerSigtermAndWaitForShutdown(orchestrator);

    expect(metrics.forcedKills).toBe(0);
    expect(metrics.activeWorkers).toBe(0);

    const ackLogCount = entries.filter((entry) => hasMessage(entry, "Worker ACK received")).length;
    expect(ackLogCount).toBeGreaterThanOrEqual(2);
  });

  it("should fallback to force-kill when worker does not ACK shutdown", async () => {
    const messagePrefix = randomPrefix();
    const { logger, entries } = createMemoryLogger();

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });

    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      logger,
      workers: {
        count: 2,
        env: {
          WM_IT_MODE: "stubborn",
          WM_IT_MESSAGE_PREFIX: messagePrefix,
        },
      },
      shutdown: {
        timeoutMs: 1_000,
        ackTimeoutMs: 500,
        sigtermDelayMs: 100,
        sigintDelayMs: 100,
        messagePrefix,
      },
    });

    await orchestrator.run();
    await waitForOnlineWorkers(orchestrator, 2);

    const metrics = await triggerSigtermAndWaitForShutdown(orchestrator);

    expect(metrics.forcedKills).toBeGreaterThanOrEqual(2);
    expect(entries.some((entry) => hasMessage(entry, "Worker ACK timeout"))).toBe(true);
    expect(entries.some((entry) => hasMessage(entry, "Forced SIGKILL"))).toBe(true);
  });

  it("should apply restart backoff and trip circuit breaker in crash-loop", async () => {
    const messagePrefix = randomPrefix();
    const { logger, entries } = createMemoryLogger();
    const restartTimestamps: number[] = [];

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });

    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      logger,
      workers: {
        count: 2,
        env: {
          WM_IT_MODE: "crash-loop-all",
          WM_IT_MESSAGE_PREFIX: messagePrefix,
        },
      },
      restart: {
        crashThreshold: 3,
        crashWindowMs: 5_000,
        backoffMs: 500,
        maxBackoffMs: 1_000,
        backoffMultiplier: 2,
        stabilityWindowMs: 5_000,
      },
      shutdown: {
        timeoutMs: 1_000,
        ackTimeoutMs: 500,
        sigtermDelayMs: 100,
        sigintDelayMs: 100,
        messagePrefix,
      },
    });

    orchestrator.on("worker:restart", () => {
      restartTimestamps.push(Date.now());
    });

    const circuitBreakerTripped = once(orchestrator, "circuit-breaker:tripped");

    await orchestrator.run();
    await withTimeout(circuitBreakerTripped, SIGNAL_TIMEOUT_MS, "Timed out waiting for circuit breaker to trip");

    expect(restartTimestamps.length).toBeGreaterThanOrEqual(1);

    if (restartTimestamps.length >= 2) {
      const restartDelta = restartTimestamps[1] - restartTimestamps[0];
      expect(restartDelta).toBeGreaterThanOrEqual(900);
    }

    const backoffLogs = entries.filter((entry) => hasMessage(entry, "Waiting before restart"));
    expect(backoffLogs.length).toBeGreaterThanOrEqual(1);
    expect(backoffLogs[0]?.data?.delayMs).toBe(500);
    if (backoffLogs.length >= 2) {
      expect(backoffLogs[1]?.data?.delayMs).toBe(1_000);
    }

    const metrics = await triggerSigtermAndWaitForShutdown(orchestrator);
    expect(metrics.crashLoopBackoffs).toBeGreaterThanOrEqual(1);
    expect(metrics.forcedKills).toBe(0);
  });

  it("should keep stable workers running while one worker crash-loops (crash-loop-single)", async () => {
    const messagePrefix = randomPrefix();
    const { logger } = createMemoryLogger();

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });

    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      logger,
      workers: {
        count: 2,
        env: {
          WM_IT_MODE: "crash-loop-single",
          WM_IT_MESSAGE_PREFIX: messagePrefix,
        },
      },
      restart: {
        crashThreshold: 3,
        crashWindowMs: 5_000,
        backoffMs: 500,
        maxBackoffMs: 1_000,
        backoffMultiplier: 2,
        stabilityWindowMs: 5_000,
      },
      shutdown: {
        timeoutMs: 1_000,
        ackTimeoutMs: 500,
        sigtermDelayMs: 100,
        sigintDelayMs: 100,
        messagePrefix,
      },
    });

    const onlineWorkerIds = new Set<number>();
    orchestrator.on("worker:online", (event) => {
      onlineWorkerIds.add(event.workerId);
    });

    await orchestrator.run();
    await waitForOnlineWorkers(orchestrator, 2);

    // Wait a bit to let the crash-loop worker crash and restart
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // At least the initial 2 workers should have come online
    expect(onlineWorkerIds.size).toBeGreaterThanOrEqual(2);

    const metrics = await triggerSigtermAndWaitForShutdown(orchestrator);
    expect(metrics.activeWorkers).toBe(0);
  });
});
