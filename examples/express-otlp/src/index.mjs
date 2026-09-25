import { Orchestrator } from "@goopil/clusterkit";
import { createOtlpMeterPlugin } from "@goopil/clusterkit-otlp-meter";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import { metrics } from "@opentelemetry/api";
import express from "express";

(async () => {
  const orchestrator = new Orchestrator({ logger: console });

  const sizing = createContainerSizingPlugin();
  const otlp = createOtlpMeterPlugin({
    endpoint: process.env?.OTLP_ENDPOINT || "http://localhost:4318/v1/metrics",
    protocol: "http",
    serviceName: "express-otlp-example",
    instrumentation: true,
    exportIntervalMs: 5_000,
    attributes: { environment: "development" },
  });

  orchestrator
    .use(sizing)
    .use(otlp)
    .run(async ({ listen, shutdown }) => {
      const app = express();

      const meter = metrics.getMeter("express-otlp-example");
      const httpRequests = meter.createCounter("http.requests", {
        description: "Total HTTP requests handled",
      });
      const activeConnections = meter.createObservableGauge("http.active_connections", {
        description: "Current in-flight connections",
      });

      let connections = 0;
      activeConnections.addCallback((result) => {
        result.observe(connections);
      });

      app.use((req, res, next) => {
        connections++;
        httpRequests.add(1, { method: req.method, route: req.path });
        res.on("finish", () => {
          connections--;
        });
        next();
      });

      app.get("/", (_req, res) => {
        res.json({ hello: "world", pid: process.pid });
      });

      app.get("/slow", (_req, res) => {
        setTimeout(() => res.json({ ok: true }), 200);
      });

      // Platform flags (SO_REUSEPORT / cluster IPC) handled for you.
      const server = listen(app, { port: +(process.env?.PORT || 3009), host: "0.0.0.0" });

      shutdown(() => {
        server.close();
      });
    });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
