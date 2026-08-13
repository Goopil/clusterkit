import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import express from "express";

// Drop-in replacement for @inertiajs/server — React edition.
// Same HTTP protocol (POST /render, GET /health), managed by ClusterKit.
//
// Build first:  pnpm build     (runs vite build → dist/server/entry-server.mjs)
// Then start:   pnpm start     (runs node src/index.mjs)
//
// Test with curl:
//   curl -s -X POST http://127.0.0.1:13715/render \
//     -H "Content-Type: application/json" \
//     -d '{"component":"Home","props":{"pid":1,"hostname":"local"},"url":"/"}'

const SSR_PORT = +(process.env.SSR_PORT || 13715);
const SSR_HOST = process.env.SSR_HOST || "127.0.0.1";

const orchestrator = new Orchestrator({ logger: console });
const capabilities = await Orchestrator.getCapabilities();

console.log("Platform:", capabilities.platform);
console.log("SO_REUSEPORT:", capabilities.reusePort);

const prometheus = createPrometheusPlugin({ metricsCacheTtlMs: 250 });

orchestrator.use(prometheus).run(async () => {
  const { render } = await import("../dist/server/entry-server.mjs");

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
  });

  app.post("/render", (req, res, next) => {
    Promise.resolve(
      (async () => {
        try {
          const html = await render(req.body);
          res.json({ body: html });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[ssr] render error:", message);
          res.status(500).json({ error: message });
        }
      })(),
    ).catch(next);
  });

  const server = app.listen({
    port: SSR_PORT,
    host: SSR_HOST,
    reusePort: capabilities.reusePort,
    exclusive: capabilities.reusePort,
  });

  console.log(`[worker ${process.pid}] SSR server listening on ${SSR_HOST}:${SSR_PORT}`);

  orchestrator.registerOnShutdown(() => server.close());
});
