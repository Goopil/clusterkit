import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";

(async () => {
  const orchestrator = new Orchestrator({ logger: console });
  const capabilities = await Orchestrator.getCapabilities();

  console.log("Platform:", capabilities.platform);
  console.log("SO_REUSEPORT:", capabilities.reusePort);

  // App server  → :3005  (workers)
  // Metrics server → :9092  (primary, bound by the plugin's serve())
  const sizing = createContainerSizingPlugin();
  const prometheus = createPrometheusPlugin({ metricsCacheTtlMs: 250 });

  // Binds in the primary only (no-op in workers); closed on shutdown by the plugin.
  await prometheus.serve({
    port: +(process.env?.METRICS_PORT || 9092),
    host: process.env.METRICS_HOST ?? "0.0.0.0",
  });

  orchestrator
    .use(sizing)
    .use(prometheus)
    .run(async () => {
      const app = new Hono();

      app.get("/", (c) => c.json({ hello: "world", pid: process.pid }));

      // createAdaptorServer returns a raw http.Server so we can pass
      // exclusive / reusePort options directly to listen().
      const server = createAdaptorServer({ fetch: app.fetch });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          {
            port: +(process.env?.PORT || 3005),
            host: "0.0.0.0",
            exclusive: capabilities.reusePort,
            reusePort: capabilities.reusePort,
          },
          () => {
            server.off("error", reject);
            resolve();
          },
        );
      });

      orchestrator.registerOnShutdown(() => {
        server.close();
      });
    });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
