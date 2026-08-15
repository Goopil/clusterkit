import cluster from "node:cluster";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "@goopil/clusterkit";
import { afterEach, describe, expect, it } from "vitest";
import { createFileWatcherPlugin } from "../src/index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_FIXTURE_PATH = resolve(__dirname, "../../worker-manager/test/fixtures/process-worker.cjs");
const PREFIX = "__fw_it";

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

describe("file-watcher integration", () => {
  it("triggers rolling restart on file change", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-int-"));
    const tempFile = join(tempDir, "app.txt");
    writeFileSync(tempFile, "initial");

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "cooperative", WM_IT_MESSAGE_PREFIX: PREFIX },
      },
      shutdown: { timeoutMs: 4_000, ackTimeoutMs: 1_000, messagePrefix: PREFIX },
    });

    const plugin = createFileWatcherPlugin({
      watch: [tempDir],
      debounceMs: 100,
      staggerMs: 100,
    });
    orchestrator.use(plugin);
    await orchestrator.run();

    // Wait for 2 workers online
    const onlineP = Promise.all([once(orchestrator, "worker:online"), once(orchestrator, "worker:online")]);
    await Promise.race([onlineP, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 5_000))]);

    const originalIds = Object.values(cluster.workers ?? {})
      .filter((w) => w !== undefined)
      .map((w) => w!.id)
      .sort();

    // Give chokidar time to settle spurious initial events on macOS
    await new Promise((r) => setTimeout(r, 500));

    // Trigger file change
    const completeP = once(orchestrator, "restart:complete");
    writeFileSync(tempFile, "changed");
    await Promise.race([completeP, new Promise((_, r) => setTimeout(() => r(new Error("restart timeout")), 8_000))]);

    // Verify new worker IDs differ
    const newIds = Object.values(cluster.workers ?? {})
      .filter((w) => w !== undefined && !w!.isDead())
      .map((w) => w!.id)
      .sort();

    expect(newIds).not.toEqual(originalIds);

    // Clean shutdown
    const shutdownP = once(orchestrator, "shutdown:complete");
    process.emit("SIGTERM");
    await shutdownP;

    rmSync(tempDir, { recursive: true, force: true });
  }, 15_000);

  it("triggers rolling restart with new env on .env file change", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-env-"));
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "APP_KEY=initial\n");

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "cooperative", WM_IT_MESSAGE_PREFIX: PREFIX },
      },
      shutdown: { timeoutMs: 4_000, ackTimeoutMs: 1_000, messagePrefix: PREFIX },
    });

    const plugin = createFileWatcherPlugin({
      envFile: [envPath],
      debounceMs: 100,
      staggerMs: 100,
    });
    orchestrator.use(plugin);
    await orchestrator.run();

    // Wait for 2 workers online
    const onlineP = Promise.all([once(orchestrator, "worker:online"), once(orchestrator, "worker:online")]);
    await Promise.race([onlineP, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 5_000))]);

    // Give chokidar time to settle spurious initial events on macOS
    await new Promise((r) => setTimeout(r, 500));

    // Modify .env file
    const completeP = once(orchestrator, "restart:complete");
    writeFileSync(envPath, "APP_KEY=updated\nNEW_KEY=new\n");
    await Promise.race([completeP, new Promise((_, r) => setTimeout(() => r(new Error("restart timeout")), 8_000))]);

    // Verify restart happened
    expect(plugin.isWatching).toBe(true);

    // Clean shutdown
    const shutdownP = once(orchestrator, "shutdown:complete");
    process.emit("SIGTERM");
    await shutdownP;

    rmSync(tempDir, { recursive: true, force: true });
  }, 15_000);
});
