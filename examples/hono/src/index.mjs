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
  // Metrics endpoint is exposed by your host app using prometheus.getMetrics().
  const sizing = createContainerSizingPlugin();
  const prometheus = createPrometheusPlugin({ metricsCacheTtlMs: 250 });

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

      orchestrator.registerOnShutdown(() => server.close());
    });
})();
