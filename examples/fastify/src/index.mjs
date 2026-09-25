import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import fastify from "fastify";

(async () => {
  const orchestrator = new Orchestrator({ logger: console });

  // App server  → :3001  (workers)
  // Metrics server → :9091  (primary, bound by the plugin's serve())
  const sizing = createContainerSizingPlugin();
  const prometheus = createPrometheusPlugin({ metricsCacheTtlMs: 250 });

  // Binds in the primary only (no-op in workers); closed on shutdown by the plugin.
  await prometheus.serve({
    port: +(process.env?.METRICS_PORT || 9091),
    host: process.env.METRICS_HOST ?? "0.0.0.0",
  });

  orchestrator
    .use(sizing)
    .use(prometheus)
    .run(async ({ listen, shutdown }) => {
      const server = fastify({ logger: true });

      server.get("/", async () => {
        return { hello: "world", pid: process.pid };
      });

      // ctx.listen injects the platform flags (SO_REUSEPORT / cluster IPC).
      await listen(server, { port: +(process.env?.PORT || 3001), host: "0.0.0.0" });

      shutdown(async () => {
        await server.close();
      });
    });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
