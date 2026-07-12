import "reflect-metadata";
import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";

async function bootstrap() {
  const orchestrator = new Orchestrator({ logger: console });
  const capabilities = await Orchestrator.getCapabilities();

  console.log("Platform:", capabilities.platform);
  console.log("SO_REUSEPORT:", capabilities.reusePort);

  // App server  → :3008  (workers)
  // Metrics endpoint is exposed by your host app using prometheus.getMetrics().
  const sizing = createContainerSizingPlugin();
  const prometheus = createPrometheusPlugin({ metricsCacheTtlMs: 250 });

  orchestrator
    .use(sizing)
    .use(prometheus)
    .run(async () => {
      const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ logger: false }));

      // init() registers NestJS routes with Fastify but does not call
      // fastify.ready(), which is what compiles the plugin/hook graph.
      // We must call ready() explicitly before listening on the raw server,
      // otherwise hook arrays are undefined and requests crash.
      await app.init();

      const fastifyInstance = app.getHttpAdapter().getInstance();
      await fastifyInstance.ready();

      fastifyInstance.server.listen({
        port: +(process.env?.PORT || 3008),
        host: "0.0.0.0",
        exclusive: capabilities.reusePort,
        reusePort: capabilities.reusePort,
      });

      orchestrator.registerOnShutdown(() => app.close());
    });
}

bootstrap();
