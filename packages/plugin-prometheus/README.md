# `@goopil/clusterkit-prometheus`

Prometheus metrics plugin for `@goopil/clusterkit`.

This package exposes orchestration metrics and merged worker metrics through `getMetrics()`.
It does **not** start an HTTP server by itself.

## Capabilities

| Capability                    | Details                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Orchestration metrics         | Tracks active workers, restarts, crashes, and circuit-breaker trips from orchestrator events |
| Worker metrics aggregation    | Uses `prom-client` `AggregatorRegistry` to collect worker default metrics                    |
| Cached merged responses       | Optional `metricsCacheTtlMs` cache for scrape bursts                                         |
| On-demand fresh scrape        | `getMetrics({ bypassCache: true })` bypasses cache per request                               |
| Primary/worker-aware behavior | Event listeners only on primary, default process metrics only on workers                     |

## Installation

```bash
pnpm add @goopil/clusterkit-prometheus prom-client
```

## Usage

```ts
import http from "node:http";
import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";

const orchestrator = new Orchestrator({ logger: console });

const prometheus = createPrometheusPlugin({
  prefix: "clusterkit_",
  metricsCacheTtlMs: 250,
  defaultMetrics: true,
});

orchestrator.use(prometheus).run(async () => {
  // your app bootstrap
});

// Expose metrics from your own HTTP stack (primary process)
const server = http.createServer(async (req, res) => {
  if (req.url !== "/metrics" || req.method !== "GET") {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }

  res.setHeader("Content-Type", prometheus.registry.contentType);
  res.end(await prometheus.getMetrics());
});

server.listen(9090, "127.0.0.1");
```

## Options (`PrometheusPluginOptions`)

| Option              | Type                               | Default          | Description                                                                                      |
| ------------------- | ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `prefix`            | `string`                           | `'clusterkit_'`  | Metric name prefix                                                                               |
| `registry`          | `Registry`                         | `new Registry()` | Registry for orchestration metrics                                                               |
| `defaultMetrics`    | `boolean`                          | `true`           | Collect Node.js default process metrics from workers (or from the primary in single-worker mode) |
| `metricsCacheTtlMs` | `number`                           | `1000`           | Merged-metrics cache TTL in milliseconds (`0` disables cache)                                    |
| `labels`            | `Record<string, string \| number>` | `{}`             | Static labels added to all metrics (`pid` is always included)                                    |

## API (`PrometheusPlugin`)

```ts
prometheus.registry;
await prometheus.getMetrics();
await prometheus.getMetrics({ bypassCache: true });
```

## Metrics exposed

With the default prefix (`clusterkit_`):

- `clusterkit_active_workers` (Gauge)
- `clusterkit_worker_restarts_total` (Counter)
- `clusterkit_worker_crashes_total` (Counter)
- `clusterkit_circuit_breaker_trips_total` (Counter)

Plus worker-level Node.js default metrics from `prom-client` when `defaultMetrics: true`.

In single-worker mode (`workers: 1`), the orchestrator runs the app directly in the
primary process without forking. The plugin sets `clusterkit_active_workers` to `1` and
collects default process metrics in the primary, since there are no worker processes to
aggregate from.

## Security / exposure notes

- This plugin does not open sockets.
- Your application controls network bind, auth, TLS, and access policy for `/metrics`.
- Prefer binding metrics to `127.0.0.1` or a private service network unless external scraping is explicitly required.
- Treat metrics as operationally sensitive because they can expose process, topology, runtime, and workload details.
- In Kubernetes, prefer a private `Service` plus network-level controls (`NetworkPolicy`, service mesh policy,
  ingress/pod policies) around the metrics endpoint.

## Benchmarking cache impact

```bash
corepack pnpm --filter @goopil/clusterkit-prometheus build
corepack pnpm --filter @goopil/clusterkit-prometheus bench:metrics-cache
```

## Related docs

- [Root README](../../README.md)
- [Core package README](../worker-manager/README.md)
