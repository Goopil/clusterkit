import "reflect-metadata";
import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const orchestrator = new Orchestrator({ logger: console });

  // App server  → :3007  (workers)
  // Metrics can be exposed by the host app on the primary via prometheus.serve() — see the plugin README.
  const sizing = createContainerSizingPlugin();
  const prometheus = createPrometheusPlugin({ metricsCacheTtlMs: 250 });

  orchestrator
    .use(sizing)
    .use(prometheus)
    .run(async ({ listen, shutdown }) => {
      const app = await NestFactory.create(AppModule, { logger: false });

      // init() sets up routes without binding to a port, giving us full
      // control over listen() via the raw HTTP server.
      await app.init();

      const httpServer = app.getHttpServer();
      // ctx.listen injects the platform flags (SO_REUSEPORT / cluster IPC).
      listen(httpServer, { port: +(process.env?.PORT || 3007), host: "0.0.0.0" });

      shutdown(() => app.close());
    });
}

bootstrap();
