import { Orchestrator } from "@goopil/clusterkit";
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

orchestrator.run(async ({ listen, shutdown }) => {
  const { render } = await import("../dist/server/entry-server.mjs");

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
  });

  app.post("/render", async (req, res) => {
    try {
      const html = await render(req.body);
      res.json({ body: html });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ssr] render error:", message);
      res.status(500).json({ error: message });
    }
  });

  // Platform flags (SO_REUSEPORT / cluster IPC) handled for you.
  const server = listen(app, { port: SSR_PORT, host: SSR_HOST });

  console.log(`[worker ${process.pid}] SSR server listening on ${SSR_HOST}:${SSR_PORT}`);

  shutdown(() => server.close());
});
