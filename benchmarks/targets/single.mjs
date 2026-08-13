import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "@goopil/clusterkit";
import express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WORKLOADS = {
  hello: "hello.mjs",
  "latency-10ms": "latency-10ms.mjs",
  "cpu-io-mix": "cpu-io-mix.mjs",
  "list-100": "list-100.mjs",
  aggregate: "aggregate.mjs",
  "auth-verify": "auth-verify.mjs",
  "error-rate": "error-rate.mjs",
  "upload-echo": "upload-echo.mjs",
};

const workload = process.env.BENCH_WORKLOAD || "hello";
const port = Number.parseInt(process.env.PORT || "3100", 10);

async function loadWorkload() {
  const handler = await import(join(__dirname, "..", "workloads", WORKLOADS[workload]));
  return handler.default;
}

const orchestrator = new Orchestrator({
  logger: null,
  workers: { count: 1 },
});

orchestrator.run(async () => {
  const handler = await loadWorkload();
  const app = express();
  app.use(express.json({ limit: "10kb" }));
  app.get("/", handler);
  app.get("/:path", handler);
  app.post("/", handler);
  app.post("/:path", handler);

  const server = app.listen({ port, host: "0.0.0.0" });
  orchestrator.registerOnShutdown(() => server.close());
});
