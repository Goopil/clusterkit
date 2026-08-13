import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import throng from "throng";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WORKLOADS = {
  hello: "hello.mjs",
  "latency-10ms": "latency-10ms.mjs",
  "cpu-io-mix": "cpu-io-mix.mjs",
};

const workload = process.env.BENCH_WORKLOAD || "hello";
const port = Number.parseInt(process.env.PORT || "3100", 10);
const count = 3;

async function loadWorkload() {
  const handler = await import(join(__dirname, "..", "workloads", WORKLOADS[workload]));
  return handler.default;
}

throng({
  count,
  worker: async () => {
    const handler = await loadWorkload();
    const app = express();
    app.get("/", handler);
    app.get("/:path", handler);
    app.listen(port, "0.0.0.0");
  },
});
