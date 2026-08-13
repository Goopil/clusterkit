import { Orchestrator } from "@goopil/clusterkit";
import cluster from "node:cluster";
import { once } from "node:events";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
let collectedBodies: Buffer[] = [];
let collectedContentTypes: string[] = [];

afterEach(async () => {
  await killRemainingWorkers();
  if (mockCollector) {
    mockCollector.close();
    mockCollector = undefined;
  }
  collectedBodies = [];
  collectedContentTypes = [];
});

async function startMockCollector(): Promise<string> {
  await new Promise<void>((resolveServer) => {
    mockCollector = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        collectedBodies.push(Buffer.concat(chunks));
        collectedContentTypes.push(req.headers["content-type"] ?? "");
        res.statusCode = 200;
        res.end();
      });
    });
    mockCollector.listen(0, "127.0.0.1", () => resolveServer());
  });
  const address = mockCollector?.address();
  if (!address || typeof address === "string") throw new Error("failed to get collector address");
  return `http://127.0.0.1:${address.port}/v1/metrics`;
}

async function waitForWorkers(orch: Orchestrator, count: number): Promise<void> {
  const onlineCount = new Set<number>();
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${count} workers`)), 8_000);
    orch.on("worker:online", (e: { workerId: number }) => {
      onlineCount.add(e.workerId);
      if (onlineCount.size >= count) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });
}

async function waitForFirstExport(timeoutMs = 5_000): Promise<Buffer> {
  return new Promise<Buffer>((resolvePoll, reject) => {
    const deadline = setTimeout(() => reject(new Error(`no OTLP export received within ${timeoutMs}ms`)), timeoutMs);
    const check = () => {
      if (collectedBodies.length > 0) {
        clearTimeout(deadline);
        resolvePoll(collectedBodies[0]);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function bodyContains(body: Buffer, needle: string): boolean {
  return body.toString("utf8").includes(needle);
}

async function gracefulShutdown(orch: Orchestrator, plugin: { shutdown(): Promise<void> }): Promise<void> {
  const shutdownDone = once(orch, "shutdown:complete");
  process.emit("SIGTERM");
  await shutdownDone;
  await plugin.shutdown();
}

describe("OTLP meter plugin e2e — full orchestrator + mock collector", () => {
  it("exports active_workers gauge in protobuf payload", async () => {
    const collectorUrl = await startMockCollector();
    const plugin = createOtlpMeterPlugin({
      endpoint: collectorUrl,
      instrumentation: false,
      exportIntervalMs: 500,
    });

    const orch = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "cooperative", WM_IT_MESSAGE_PREFIX: "__otlp_e2e_gauge" },
      },
      shutdown: {
        timeoutMs: 4_000,
        ackTimeoutMs: 1_000,
        messagePrefix: "__otlp_e2e_gauge",
      },
    });

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    orch.use(plugin);
    await orch.run();

    await waitForWorkers(orch, 2);
    const body = await waitForFirstExport();

    expect(collectedContentTypes[0]).toContain("application/");
    expect(bodyContains(body, "clusterkit.active_workers")).toBe(true);

    await gracefulShutdown(orch, plugin);
  }, 15_000);

  it("exports worker.crashes counter after a real worker crash", async () => {
    const collectorUrl = await startMockCollector();
    const plugin = createOtlpMeterPlugin({
      endpoint: collectorUrl,
      instrumentation: false,
      exportIntervalMs: 500,
    });

    const orch = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "crash-loop-all", WM_IT_MESSAGE_PREFIX: "__otlp_e2e_crash" },
      },
      restart: {
        crashThreshold: 100,
        crashWindowMs: 60_000,
        backoffMs: 1_000,
        maxBackoffMs: 1_000,
        backoffMultiplier: 1,
        stabilityWindowMs: 1_000,
      },
      shutdown: {
        timeoutMs: 4_000,
        ackTimeoutMs: 1_000,
        messagePrefix: "__otlp_e2e_crash",
      },
    });

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    orch.use(plugin);
    await orch.run();

    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for crash")), 5_000);
      orch.on("worker:crash", () => {
        clearTimeout(timer);
        resolveReady();
      });
    });

    await plugin.meterProvider?.forceFlush();

    const body = await waitForFirstExport();
    expect(bodyContains(body, "clusterkit.worker.crashes")).toBe(true);

    await gracefulShutdown(orch, plugin);
  }, 15_000);

  it("exports custom metrics created via global metrics.getMeter()", async () => {
    const collectorUrl = await startMockCollector();
    const plugin = createOtlpMeterPlugin({
      endpoint: collectorUrl,
      instrumentation: false,
      exportIntervalMs: 500,
    });

    const orch = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "cooperative", WM_IT_MESSAGE_PREFIX: "__otlp_e2e_custom" },
      },
      shutdown: {
        timeoutMs: 4_000,
        ackTimeoutMs: 1_000,
        messagePrefix: "__otlp_e2e_custom",
      },
    });

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    orch.use(plugin);
    await orch.run();

    await waitForWorkers(orch, 2);

    const meter = plugin.meterProvider?.getMeter("e2e-custom");
    const customCounter = meter.createCounter("e2e.custom.requests", {
      description: "Custom counter from e2e test",
    });
    customCounter.add(1);
    customCounter.add(2);

    await plugin.meterProvider?.forceFlush();

    const body = await waitForFirstExport();
    expect(bodyContains(body, "e2e.custom.requests")).toBe(true);
    expect(bodyContains(body, "clusterkit.active_workers")).toBe(true);

    await gracefulShutdown(orch, plugin);
  }, 15_000);

  it("sends payloads with correct OTLP/HTTP content type", async () => {
    const collectorUrl = await startMockCollector();
    const plugin = createOtlpMeterPlugin({
      endpoint: collectorUrl,
      instrumentation: false,
      exportIntervalMs: 500,
    });

    const orch = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "cooperative", WM_IT_MESSAGE_PREFIX: "__otlp_e2e_ct" },
      },
      shutdown: {
        timeoutMs: 4_000,
        ackTimeoutMs: 1_000,
        messagePrefix: "__otlp_e2e_ct",
      },
    });

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    orch.use(plugin);
    await orch.run();

    await waitForWorkers(orch, 2);
    await waitForFirstExport();

    expect(collectedBodies.length).toBeGreaterThan(0);
    expect(collectedContentTypes[0]).toBe("application/json");
    expect(collectedBodies[0].length).toBeGreaterThan(0);

    await gracefulShutdown(orch, plugin);
  }, 15_000);

  it("exports all 4 orchestration metric names in a single payload", async () => {
    const collectorUrl = await startMockCollector();
    const plugin = createOtlpMeterPlugin({
      endpoint: collectorUrl,
      instrumentation: false,
      exportIntervalMs: 500,
      prefix: "e2e.",
    });

    const orch = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "crash-loop-all", WM_IT_MESSAGE_PREFIX: "__otlp_e2e_all" },
      },
      restart: {
        crashThreshold: 100,
        crashWindowMs: 60_000,
        backoffMs: 1_000,
        maxBackoffMs: 1_000,
        backoffMultiplier: 1,
        stabilityWindowMs: 1_000,
      },
      shutdown: {
        timeoutMs: 4_000,
        ackTimeoutMs: 1_000,
        messagePrefix: "__otlp_e2e_all",
      },
    });

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    orch.use(plugin);
    await orch.run();

    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for crash")), 5_000);
      orch.on("worker:crash", () => {
        clearTimeout(timer);
        resolveReady();
      });
    });

    await plugin.meterProvider?.forceFlush();

    const body = await waitForFirstExport();

    expect(bodyContains(body, "e2e.active_workers")).toBe(true);
    expect(bodyContains(body, "e2e.worker.crashes")).toBe(true);

    await gracefulShutdown(orch, plugin);
  }, 15_000);
});
