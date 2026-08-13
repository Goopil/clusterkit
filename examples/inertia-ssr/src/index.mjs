import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import express from "express";

// This is a drop-in replacement for @inertiajs/server.
// It exposes the same HTTP protocol (POST /render, GET /health) that Laravel
// uses to call the Inertia SSR renderer, but managed by ClusterKit so that
// multiple worker processes share port 13714 via SO_REUSEPORT (Linux) or
// cluster IPC (macOS / fallback).
//
// Build first:  pnpm build     (runs vite build --ssr)
// Then start:   pnpm start     (runs node src/index.mjs)
//
// Test with curl:
//   curl -s -X POST http://127.0.0.1:13714/render \
//     -H "Content-Type: application/json" \
//     -d '{"component":"Home","props":{"pid":1,"hostname":"local"},"url":"/"}'

const SSR_PORT = +(process.env.SSR_PORT || 13714);
const SSR_HOST = process.env.SSR_HOST || "127.0.0.1";

const orchestrator = new Orchestrator({ logger: console });
const capabilities = await Orchestrator.getCapabilities();

console.log("Platform:", capabilities.platform);
console.log("SO_REUSEPORT:", capabilities.reusePort);

const prometheus = createPrometheusPlugin({ metricsCacheTtlMs: 250 });

orchestrator.use(prometheus).run(async () => {
  // Dynamically import the SSR bundle produced by `vite build --ssr`.
  // Each worker gets its own isolated module instance — no shared state.
  const { render } = await import("../dist/server/entry-server.mjs");

  const app = express();
  app.use(express.json());

  // Health endpoint — mirrors @inertiajs/server behaviour
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
  });

  // Render endpoint — called by Laravel for every Inertia SSR page
  app.post("/render", (req, res, next) => {
    Promise.resolve(
      (async () => {
        try {
          const html = await render(req.body);
          res.json({ body: html });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[ssr] render error:", message);
          // Returning 500 makes Laravel fall back to client-side rendering
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
