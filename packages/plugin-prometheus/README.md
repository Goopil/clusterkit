# `@goopil/clusterkit-prometheus`

Prometheus metrics plugin for `@goopil/clusterkit`.

This package exposes orchestration metrics and merged worker metrics through `getMetrics()`.
It does **not** start an HTTP server by itself.

## Capabilities

| Capability | Details |
|------------|---------|
| Orchestration metrics | Tracks active workers, restarts, crashes, and circuit-breaker trips from orchestrator events |
| Worker metrics aggregation | Uses `prom-client` `AggregatorRegistry` to collect worker default metrics |
| Cached merged responses | Optional `metricsCacheTtlMs` cache for scrape bursts |
| Primary/worker-aware behavior | Event listeners only on primary, default process metrics only on workers |

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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prefix` | `string` | `'clusterkit_'` | Metric name prefix |
| `registry` | `Registry` | `new Registry()` | Registry for orchestration metrics |
| `defaultMetrics` | `boolean` | `true` | Collect Node.js default process metrics from workers (or from the primary in single-worker mode) |
| `metricsCacheTtlMs` | `number` | `1000` | Merged-metrics cache TTL in milliseconds (`0` disables cache) |
| `labels` | `Record<string, string \| number>` | `{}` | Static labels added to all metrics (`pid` is always included) |

## API (`PrometheusPlugin`)

```ts
prometheus.registry;
await prometheus.getMetrics();
```

`getMetrics()` must be called in the primary process — orchestration metrics are only
updated there (event listeners bind on the primary only). Calling it from a worker
throws with an explicit error instead of silently returning all-zero metrics.

## Metrics exposed

With the default prefix (`clusterkit_`):

Orchestration metrics (primary, event-driven):

- `clusterkit_active_workers` (Gauge) — Number of active cluster workers
- `clusterkit_worker_restarts_total` (Counter) — Total number of worker restarts
- `clusterkit_worker_crashes_total` (Counter) — Total number of worker crashes
- `clusterkit_circuit_breaker_trips_total` (Counter) — Total number of circuit breaker trips

Worker health metrics (per worker, driven by `worker:health` events — require `health.heartbeatMs > 0`):

- `clusterkit_worker_rss_bytes` (Gauge, `workerId`) — Resident set size per worker (from health heartbeat)
- `clusterkit_worker_heap_used_bytes` (Gauge, `workerId`) — Heap used per worker (from health heartbeat)
- `clusterkit_worker_eventloop_lag_ms` (Gauge, `workerId`) — Event loop lag per worker (from health heartbeat)
- `clusterkit_worker_heartbeat_age_seconds` (Gauge, `workerId`) — Seconds since the worker's last health report (large = wedged risk)

Recovery metrics:

- `clusterkit_worker_recycles_total{reason}` (Counter) — Total number of worker recycles by reason (`maxAge`, `rss`, `wedged`)
- `clusterkit_worker_wedged_kills_total` (Counter) — Total number of workers killed for being wedged
- `clusterkit_recovery_duration_seconds` (Gauge) — Duration of the last fleet degradation until recovery

Fleet gauges (read `getFleetHealth()` live on every scrape):

- `clusterkit_fleet_active_workers` (Gauge) — Currently active workers (live fleet health)
- `clusterkit_fleet_target_workers` (Gauge) — Target worker count (live fleet health)
- `clusterkit_fleet_quarantined_slots` (Gauge) — Quarantined worker slots (live fleet health)

Labeled counters (`worker_recycles_total`) only appear once their first series is recorded. Plus worker-level Node.js
default metrics from `prom-client` when `defaultMetrics: true`.

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

### Trust boundary: workers are trusted

Workers are forked from the same entrypoint as the primary and are therefore considered **trusted**. This
distinction matters because `prom-client`'s `AggregatorRegistry` — used by this plugin to aggregate worker
metrics — attaches a `cluster.on('message')` listener in the primary that does **not** validate incoming
`prom-client:getMetricsRes` messages. A worker sending a malformed response (unknown or stale `requestId`,
missing `metrics` array) triggers a `TypeError` inside the primary's message listener, which Node surfaces as
an `uncaughtException` and crashes the primary. A buggy or compromised worker can therefore crash the primary
with a single malformed IPC message.

Known limitation in `prom-client` below **v0.16.0** (incl. 15.1.3, the latest release in this plugin's peer range
`>=14 <16`): while a worker is dead or recycling, scrapes time out and `AggregatorRegistry.clusterMetrics()` never
removes the pending entry from its internal requests `Map` — primary RSS grows slowly (e.g. with workers in a crash
loop). Unexpected `getMetricsRes` messages can also crash the primary (no response validation). Both are fixed in
[prom-client v0.16.0](https://github.com/siimon/prom-client/releases/tag/v0.16.0) (`clusterMetrics()` reworked with
`finally`-based cleanup plus response guards), which sits outside the peer range — bump `prom-client` to `^0.16.0`
yourself if you need the fix. There is no in-plugin mitigation for either issue. If your threat model includes
untrusted code executing inside worker processes, prefer an external metrics sidecar over in-process cluster
aggregation.

## Related docs

- [Root README](../../README.md)
- [Core package README](../worker-manager/README.md)