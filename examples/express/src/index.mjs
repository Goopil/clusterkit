import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import express from "express";

(async () => {
  const orchestrator = new Orchestrator({ logger: console });
  const capabilities = await Orchestrator.getCapabilities();

  console.log("Platform:", capabilities.platform);
  console.log("SO_REUSEPORT:", capabilities.reusePort);

  // App server  → :3000  (workers)
  // Metrics server → :9090  (primary, bound by the plugin's serve())
  const sizing = createContainerSizingPlugin();
  const prometheus = createPrometheusPlugin({ metricsCacheTtlMs: 250 });

  // Binds in the primary only (no-op in workers); closed on shutdown by the plugin.
  await prometheus.serve({
    port: +(process.env?.METRICS_PORT || 9090),
    host: process.env.METRICS_HOST ?? "0.0.0.0",
  });

  orchestrator
    .use(sizing)
    .use(prometheus)
    .run(async () => {
      const app = express();

      app.get("/", (_req, res) => {
        res.json({ hello: "world", pid: process.pid });
      });

      const server = app.listen({
        port: +(process.env?.PORT || 3000),
        host: "0.0.0.0",
        exclusive: capabilities.reusePort,
        reusePort: capabilities.reusePort,
      });

      orchestrator.registerOnShutdown(() => {
        server.close();
      });
    });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
