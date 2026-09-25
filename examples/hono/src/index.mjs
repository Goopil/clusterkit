import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";

(async () => {
  const orchestrator = new Orchestrator({ logger: console });

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
    .run(async ({ listen, shutdown }) => {
      const app = new Hono();

      app.get("/", (c) => c.json({ hello: "world", pid: process.pid }));

      // createAdaptorServer returns a raw http.Server; ctx.listen injects the
      // platform flags (SO_REUSEPORT / cluster IPC).
      const server = createAdaptorServer({ fetch: app.fetch });
      listen(server, { port: +(process.env?.PORT || 3005), host: "0.0.0.0" });

      shutdown(() => {
        server.close();
      });
    });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
