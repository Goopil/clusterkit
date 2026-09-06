import cluster from "node:cluster";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "@goopil/clusterkit";
import { afterEach, describe, expect, it } from "vitest";
import { createSignalRestartPlugin } from "../src/index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_FIXTURE_PATH = resolve(__dirname, "../../../test-support/fixtures/process-worker.cjs");
const PREFIX = "__sigrestart_it";

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
  process.removeAllListeners("SIGHUP");
});

describe("signal-restart integration", () => {
  it("performs rolling restart on SIGHUP in multi-worker mode", async () => {
    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "cooperative", WM_IT_MESSAGE_PREFIX: PREFIX },
      },
      shutdown: { timeoutMs: 4_000, ackTimeoutMs: 1_000, messagePrefix: PREFIX },
    });

    const plugin = createSignalRestartPlugin({ staggerMs: 100 });
    orchestrator.use(plugin);
    await orchestrator.run();

    // Wait for 2 workers online
    const onlineP = Promise.all([once(orchestrator, "worker:online"), once(orchestrator, "worker:online")]);
    await Promise.race([onlineP, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 5_000))]);

    const originalIds = Object.values(cluster.workers ?? {})
      .filter((w) => w !== undefined)
      .map((w) => w!.id)
      .sort();

    // Trigger restart
    const completeP = once(orchestrator, "restart:complete");
    process.emit("SIGHUP");
    await completeP;

    // Verify new worker IDs differ from originals
    const newIds = Object.values(cluster.workers ?? {})
      .filter((w) => w !== undefined && !w!.isDead())
      .map((w) => w!.id)
      .sort();

    expect(newIds).not.toEqual(originalIds);

    // Clean shutdown
    const shutdownP = once(orchestrator, "shutdown:complete");
    process.emit("SIGTERM");
    await shutdownP;
  }, 15_000);

  it("rolls the single worker on SIGHUP at count 1", async () => {
    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: { count: 1 },
      shutdown: { timeoutMs: 4_000, ackTimeoutMs: 1_000, messagePrefix: PREFIX },
    });

    const plugin = createSignalRestartPlugin();
    orchestrator.use(plugin);
    await orchestrator.run();

    const restartP = once(orchestrator, "restart:complete");
    process.emit("SIGHUP");

    await Promise.race([restartP, new Promise((_, r) => setTimeout(() => r(new Error("restart timeout")), 8_000))]);

    expect(plugin.lastRestart).toBeInstanceOf(Date);
  }, 15_000);
});
