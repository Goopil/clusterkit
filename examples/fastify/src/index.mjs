import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import fastify from "fastify";

(async () => {
  const orchestrator = new Orchestrator({ logger: console });
  const capabilities = await Orchestrator.getCapabilities();

  console.log("Platform:", capabilities.platform);
  console.log("SO_REUSEPORT:", capabilities.reusePort);

  // App server  → :3001  (workers)
  // Metrics endpoint is exposed by your host app using prometheus.getMetrics().
  const sizing = createContainerSizingPlugin();
  const prometheus = createPrometheusPlugin({ metricsCacheTtlMs: 250 });

  orchestrator
    .use(sizing)
    .use(prometheus)
    .run(async () => {
      const server = fastify({ logger: true });

      server.get("/", async () => {
        return { hello: "world", pid: process.pid };
      });

      await server.listen({
        port: +(process.env?.PORT || 3001),
        host: "0.0.0.0",
        exclusive: capabilities.reusePort,
        reusePort: capabilities.reusePort,
      });

      orchestrator.registerOnShutdown(() => server.close());
    });
})();
