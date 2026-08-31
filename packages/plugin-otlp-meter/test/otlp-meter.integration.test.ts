import cluster from "node:cluster";
import { once } from "node:events";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "@goopil/clusterkit";
import { afterEach, describe, expect, it } from "vitest";
import { createOtlpMeterPlugin } from "../src/index";

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

let mockCollector: http.Server | undefined;
let collectedRequests: Buffer[] = [];

afterEach(async () => {
  await killRemainingWorkers();
  if (mockCollector) {
    mockCollector.close();
    mockCollector = undefined;
  }
  collectedRequests = [];
});

describe("OTLP meter plugin integration with real orchestrator", () => {
  it("exports orchestration metrics to a mock OTLP collector", async () => {
    await new Promise<void>((resolveServer) => {
      mockCollector = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          collectedRequests.push(Buffer.concat(chunks));
          res.statusCode = 200;
          res.end();
        });
      });
      mockCollector.listen(0, "127.0.0.1", () => resolveServer());
    });

    const address = mockCollector!.address();
    if (!address || typeof address === "string") throw new Error("failed to get collector address");
    const collectorUrl = `http://127.0.0.1:${address.port}/v1/metrics`;

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });

    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "cooperative", WM_IT_MESSAGE_PREFIX: "__otlp_it" },
      },
      shutdown: {
        timeoutMs: 4_000,
        ackTimeoutMs: 1_000,
        messagePrefix: "__otlp_it",
      },
    });

    const plugin = createOtlpMeterPlugin({
      endpoint: collectorUrl,
      protocol: "http",
      instrumentation: false,
      exportIntervalMs: 1000,
    });

    orchestrator.use(plugin);

    await orchestrator.run();

    const onlineCount = new Set<number>();
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for workers")), 8_000);
      orchestrator.on("worker:online", (e: { workerId: number }) => {
        onlineCount.add(e.workerId);
        if (onlineCount.size >= 2) {
          clearTimeout(timer);
          resolveReady();
        }
      });
    });

    await new Promise<void>((resolvePoll, reject) => {
      const deadline = setTimeout(() => reject(new Error("no OTLP export received within 5s")), 5_000);
      const check = () => {
        if (collectedRequests.length > 0) {
          clearTimeout(deadline);
          resolvePoll();
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });

    expect(collectedRequests.length).toBeGreaterThan(0);

    const shutdownDone = once(orchestrator, "shutdown:complete");
    process.emit("SIGTERM");
    await shutdownDone;

    await plugin.shutdown();
  }, 15_000);
});
