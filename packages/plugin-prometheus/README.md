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
| On-demand fresh scrape | `getMetrics({ bypassCache: true })` bypasses cache per request (server-side use only — see [bypassCache warning](#bypasscache-never-map-it-to-user-facing-input)) |
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

### `bypassCache`: never map it to user-facing input

`getMetrics({ bypassCache: true })` forces a fresh scrape and deliberately skips the in-flight request dedup.
Every bypass call triggers a cluster IPC fan-out: one `getMetricsReq` message to each connected worker.
Do not wire `bypassCache` to anything user-facing (query parameter, header, webhook, …) — an untrusted client
could then trigger unbounded IPC fan-out at will, amplifying a single HTTP request into `workers` IPC messages
per scrape. Keep it behind server-side logic (admin tooling, explicit operational triggers) instead.

### Trust boundary: workers are trusted

Workers are forked from the same entrypoint as the primary and are therefore considered **trusted**. This
distinction matters because `prom-client`'s `AggregatorRegistry` — used by this plugin to aggregate worker
metrics — attaches a `cluster.on('message')` listener in the primary that does **not** validate incoming
`prom-client:getMetricsRes` messages. A worker sending a malformed response (unknown or stale `requestId`,
missing `metrics` array) triggers a `TypeError` inside the primary's message listener, which Node surfaces as
an `uncaughtException` and crashes the primary. A buggy or compromised worker can therefore crash the primary
with a single malformed IPC message.

Known limitations in `prom-client` (`lib/cluster.js`), verified against **15.1.3** — the latest release at the
time of writing; no patched release exists yet:

- No validation of `getMetricsRes` messages on the primary: an unknown `requestId` hits
  `request.done(...)`/`request.pending--` on `undefined` → `TypeError` → primary crash.
- Scrape timeouts never remove the pending request from the internal requests `Map`, so each timed-out scrape
  leaks an entry — slow memory growth, e.g. with workers in a crash loop (every scrape times out).

There is no in-plugin mitigation for either issue; the fix belongs upstream. Check or file an issue at
[siimon/prom-client](https://github.com/siimon/prom-client) (`lib/cluster.js`) and track a patched release —
the peer range here (`>=14 <16`) can be raised once one lands. If your threat model includes untrusted code
executing inside worker processes, prefer an external metrics sidecar over in-process cluster aggregation.

## Benchmarking cache impact

```bash
corepack pnpm --filter @goopil/clusterkit-prometheus build
corepack pnpm --filter @goopil/clusterkit-prometheus bench:metrics-cache
```

## Related docs

- [Root README](../../README.md)
- [Core package README](../worker-manager/README.md)