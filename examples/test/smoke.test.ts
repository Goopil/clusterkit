// examples/test/smoke.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { fetchUrl, startExample, waitForPort } from "./smoke-harness.mjs";

const examples = [
  { name: "express", port: 13000, metricsPort: 19090 },
  { name: "fastify", port: 13001, metricsPort: 19091 },
  { name: "hono", port: 13005, metricsPort: 19092 },
  { name: "koa", port: 13006, metricsPort: 19093 },
];

const running: Array<{ stopAndWait: () => Promise<void> }> = [];

afterEach(async () => {
  for (const r of running) await r.stopAndWait();
  running.length = 0;
});

describe.each(examples)("example: $name", ({ name, port, metricsPort }) => {
  it("responds 200 on the root endpoint", async () => {
    const proc = startExample(name, { PORT: String(port), METRICS_PORT: String(metricsPort) });
    running.push(proc);

    await waitForPort(port, 15_000);

    const { status, body } = await fetchUrl(`http://127.0.0.1:${port}/`);
    expect(status).toBe(200);
    expect(body).toContain("hello");
  }, 20_000);

  it("exposes metrics on the metrics port", async () => {
    const proc = startExample(name, { PORT: String(port), METRICS_PORT: String(metricsPort) });
    running.push(proc);

    await waitForPort(metricsPort, 15_000);

    const { status, body, contentType } = await fetchUrl(`http://127.0.0.1:${metricsPort}/metrics`);
    expect(status).toBe(200);
    expect(contentType).toContain("text/plain");
    expect(body).toContain("clusterkit_active_workers");
  }, 20_000);
});
