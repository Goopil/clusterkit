import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WORKLOADS = {
  hello: "hello.mjs",
  "latency-10ms": "latency-10ms.mjs",
  "cpu-io-mix": "cpu-io-mix.mjs",
};

const workload = process.env.BENCH_WORKLOAD || "hello";

async function start() {
  const handler = await import(join(__dirname, "workloads", WORKLOADS[workload]));
  const app = express();
  app.get("/", handler.default);
  app.get("/:path", handler.default);

  const port = Number.parseInt(process.env.PORT || "3100", 10);
  app.listen(port, "0.0.0.0");
}

start();
