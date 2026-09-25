import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import Koa from "koa";

(async () => {
  const orchestrator = new Orchestrator({ logger: console });

  // App server  → :3006  (workers)
  // Metrics server → :9093  (primary, bound by the plugin's serve())
  const sizing = createContainerSizingPlugin();
  const prometheus = createPrometheusPlugin({ metricsCacheTtlMs: 250 });

  // Binds in the primary only (no-op in workers); closed on shutdown by the plugin.
  await prometheus.serve({
    port: +(process.env?.METRICS_PORT || 9093),
    host: process.env.METRICS_HOST ?? "0.0.0.0",
  });

  orchestrator
    .use(sizing)
    .use(prometheus)
    .run(async ({ listen, shutdown }) => {
      const app = new Koa();

      app.use(async (ctx) => {
        if (ctx.method === "GET" && ctx.path === "/") {
          ctx.body = { hello: "world", pid: process.pid };
        }
      });

      // app.listen() forwards to the underlying net.Server; ctx.listen adds the
      // platform flags (SO_REUSEPORT / cluster IPC).
      const server = listen(app, { port: +(process.env?.PORT || 3006), host: "0.0.0.0" });

      shutdown(() => {
        server.close();
      });
    });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
