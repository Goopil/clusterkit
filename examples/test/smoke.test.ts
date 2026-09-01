// examples/test/smoke.test.ts
// Boot-smoke: every example process starts and its app endpoint responds.
//
// Metrics endpoints are intentionally NOT asserted: in multi-worker mode the
// .run() callback (which mounts the examples' metrics servers) executes in
// worker processes, while prometheus.getMetrics() must be called on the
// primary. How examples should expose metrics is an open decision tracked in
// issue #95 (AUDIT-030) — boot behavior is decision-independent.
import { afterEach, describe, expect, it } from "vitest";
import { fetchUrl, startExample, waitForPort } from "./smoke-harness.mjs";

type SmokeExample = {
  name: string;
  port: number;
  // Every example gets its own metrics port: examples with a metrics server
  // (express/fastify/hono/koa) must never bind their documented default
  // (9090-9093), which may collide with other services on the host.
  metricsPort: number;
  /** Env var the example reads its app port from (defaults to PORT). */
  portEnv?: string;
  /** Entry file relative to the repo root (defaults to the example's src/index.mjs). */
  entry?: string;
  /** HTTP path probed after boot (defaults to /). */
  path?: string;
  bodyContains?: string;
};

const examples: SmokeExample[] = [
  { name: "express", port: 13000, metricsPort: 19090 },
  { name: "fastify", port: 13001, metricsPort: 19091 },
  { name: "hono", port: 13005, metricsPort: 19092 },
  { name: "koa", port: 13006, metricsPort: 19093 },
  { name: "express-otlp", port: 13009, metricsPort: 19094 },
  { name: "hot-reload", port: 13010, metricsPort: 19095 },
  // Built TypeScript examples — need `pnpm build` (tsc) before booting
  { name: "nestjs-express", port: 13007, metricsPort: 19096, entry: "examples/nestjs-express/dist/main.js" },
  { name: "nestjs-fastify", port: 13008, metricsPort: 19097, entry: "examples/nestjs-fastify/dist/main.js" },
  // SSR examples — need `pnpm build` (vite) and read SSR_PORT instead of PORT
  { name: "inertia-ssr", port: 23714, metricsPort: 19098, portEnv: "SSR_PORT", path: "/health", bodyContains: "ok" },
  {
    name: "inertia-ssr-react",
    port: 23715,
    metricsPort: 19099,
    portEnv: "SSR_PORT",
    path: "/health",
    bodyContains: "ok",
  },
];

const running: Array<{ stopAndWait: () => Promise<void> }> = [];

afterEach(async () => {
  for (const r of running) await r.stopAndWait();
  running.length = 0;
}, 15_000);

describe.each(examples)(
  "example: $name",
  ({ name, port, metricsPort, entry, portEnv = "PORT", path = "/", bodyContains = "hello" }) => {
    it(`boots and responds 200 on ${path}`, async () => {
      const proc = startExample(name, { [portEnv]: String(port), METRICS_PORT: String(metricsPort) }, entry);
      running.push(proc);

      await waitForPort(port, 20_000);

      const { status, body } = await fetchUrl(`http://127.0.0.1:${port}${path}`);
      expect(status).toBe(200);
      expect(body).toContain(bodyContains);
    }, 30_000);
  },
);
