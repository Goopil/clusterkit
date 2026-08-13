import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "@goopil/clusterkit";
import express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WORKLOADS = {
  hello: "hello.mjs",
  "latency-10ms": "latency-10ms.mjs",
  "cpu-io-mix": "cpu-io-mix.mjs",
};

const workload = process.env.BENCH_WORKLOAD || "hello";
const port = Number.parseInt(process.env.PORT || "3100", 10);

async function loadWorkload() {
  const handler = await import(join(__dirname, "..", "workloads", WORKLOADS[workload]));
  return handler.default;
}

const capabilities = await Orchestrator.getCapabilities();

const orchestrator = new Orchestrator({
  logger: null,
  workers: { count: 3 },
});

orchestrator.run(async () => {
  const handler = await loadWorkload();
  const app = express();
  app.get("/", handler);
  app.get("/:path", handler);

  const server = app.listen({
    port,
    host: "0.0.0.0",
    exclusive: capabilities.reusePort,
    reusePort: capabilities.reusePort,
  });
  orchestrator.registerOnShutdown(() => server.close());
});
