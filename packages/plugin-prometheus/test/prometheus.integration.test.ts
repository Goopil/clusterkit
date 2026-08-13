import { Orchestrator } from "@goopil/clusterkit";
import cluster from "node:cluster";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createPrometheusPlugin } from "../src/index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_FIXTURE_PATH = resolve(__dirname, "../../worker-manager/test/fixtures/process-worker.cjs");

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

describe("Prometheus plugin integration with real orchestrator", () => {
  it("collects metrics from primary and reports worker events", async () => {
    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });

    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "cooperative", WM_IT_MESSAGE_PREFIX: "__prom_it" },
      },
      shutdown: {
        timeoutMs: 4_000,
        ackTimeoutMs: 1_000,
        messagePrefix: "__prom_it",
      },
    });

    const plugin = createPrometheusPlugin({ metricsCacheTtlMs: 0, defaultMetrics: false });
    orchestrator.use(plugin);

    await orchestrator.run();

    // Wait for 2 workers online
    const onlineCount = new Set<number>();
    await new Promise<void>((resolveWorkerCount, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for workers")), 8_000);
      orchestrator.on("worker:online", (e) => {
        onlineCount.add(e.workerId);
        if (onlineCount.size >= 2) {
          clearTimeout(timer);
          resolveWorkerCount();
        }
      });
    });

    // Give a moment for the gauge to settle
    await new Promise((r) => setTimeout(r, 100));

    const metricsText = await plugin.getMetrics();
    expect(metricsText).toContain("clusterkit_active_workers");
    // 2 workers should be reflected
    expect(metricsText).toMatch(/clusterkit_active_workers(?:\{[^}]*\})? 2/);

    // Graceful shutdown
    const shutdownDone = once(orchestrator, "shutdown:complete");
    process.emit("SIGTERM");
    await shutdownDone;

    const finalMetrics = await plugin.getMetrics();
    expect(finalMetrics).toContain("clusterkit_active_workers");
  }, 15_000);
});
