import cluster from "node:cluster";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { Orchestrator } from "../src/orchestrator";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_FIXTURE_PATH = resolve(__dirname, "fixtures/process-worker.cjs");

async function killRemainingWorkers(): Promise<void> {
  const workers = Object.values(cluster.workers ?? {}).filter((w): w is cluster.Worker => w !== undefined);
  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((r) => {
          if (w.isDead()) return r();
          const t = setTimeout(r, 1_500);
          w.once("exit", () => {
            clearTimeout(t);
            r();
          });
          w.process.kill("SIGKILL");
        }),
    ),
  );
}

afterEach(async () => {
  await killRemainingWorkers();
});

describe("Orchestrator stress tests", () => {
  it("handles rapid crash-loop bursts and stabilizes after circuit breaker reset", async () => {
    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });

    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 3,
        env: { WM_IT_MODE: "crash-loop-all", WM_IT_MESSAGE_PREFIX: "__stress" },
      },
      restart: {
        crashThreshold: 5,
        crashWindowMs: 3_000,
        backoffMs: 100,
        maxBackoffMs: 1_000,
        backoffMultiplier: 2,
        stabilityWindowMs: 1_000,
      },
      shutdown: {
        timeoutMs: 2_000,
        ackTimeoutMs: 1_000,
        sigtermDelayMs: 100,
        sigintDelayMs: 100,
        messagePrefix: "__stress",
      },
    });

    let crashCount = 0;
    orchestrator.on("worker:crash", () => {
      crashCount++;
    });

    let circuitTripped = false;
    orchestrator.on("circuit-breaker:tripped", () => {
      circuitTripped = true;
    });

    await orchestrator.run();

    // Wait for the circuit breaker to trip
    await new Promise<void>((resolveBreaker, reject) => {
      const timer = setTimeout(() => reject(new Error("circuit breaker did not trip")), 10_000);
      orchestrator.on("circuit-breaker:tripped", () => {
        clearTimeout(timer);
        resolveBreaker();
      });
    });

    expect(circuitTripped).toBe(true);
    expect(crashCount).toBeGreaterThanOrEqual(5);

    // Verify health is not ready after circuit breaker trips
    const health = orchestrator.getHealth();
    expect(health.ready).toBe(false);

    // Reset the circuit breaker and verify the system can recover
    orchestrator.resetCircuitBreaker();
    expect(orchestrator.getHealth().ready).toBe(true);

    // Graceful shutdown
    const shutdownDone = once(orchestrator, "shutdown:complete");
    process.emit("SIGTERM");
    const [{ metrics }] = (await shutdownDone) as [{ metrics: { forcedKills: number; activeWorkers: number } }];

    expect(metrics.activeWorkers).toBe(0);
  }, 30_000);
});
