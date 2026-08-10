import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import Koa from "koa";

(async () => {
  const orchestrator = new Orchestrator({ logger: console });
  const capabilities = await Orchestrator.getCapabilities();

  console.log("Platform:", capabilities.platform);
  console.log("SO_REUSEPORT:", capabilities.reusePort);

  // App server  → :3006  (workers)
  // Metrics endpoint is exposed by your host app using prometheus.getMetrics().
  const sizing = createContainerSizingPlugin();
  const prometheus = createPrometheusPlugin({ metricsCacheTtlMs: 250 });

  orchestrator
    .use(sizing)
    .use(prometheus)
    .run(async () => {
      const app = new Koa();

      app.use(async (ctx) => {
        if (ctx.method === "GET" && ctx.path === "/") {
          ctx.body = { hello: "world", pid: process.pid };
        }
      });

      // app.listen() forwards its arguments directly to the underlying
      // net.Server.listen(), so exclusive / reusePort work as expected.
      const server = app.listen({
        port: +(process.env?.PORT || 3006),
        host: "0.0.0.0",
        exclusive: capabilities.reusePort,
        reusePort: capabilities.reusePort,
      });

      const metricsApp = new Koa();
      metricsApp.use(async (ctx) => {
        if (ctx.method === "GET" && ctx.path === "/metrics") {
          ctx.type = prometheus.registry.contentType;
          ctx.body = await prometheus.getMetrics();
        }
      });
      const metricsServer = metricsApp.listen({
        port: +(process.env?.METRICS_PORT || 9093),
        host: "0.0.0.0",
      });

      orchestrator.registerOnShutdown(() => {
        server.close();
        metricsServer.close();
      });
    });
})();
