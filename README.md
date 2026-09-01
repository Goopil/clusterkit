# clusterkit

[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen)](https://nodejs.org)
[![CI](https://github.com/Goopil/clusterkit/actions/workflows/ci.yml/badge.svg)](https://github.com/Goopil/clusterkit/actions/workflows/ci.yml)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Goopil_clusterkit&metric=alert_status)](https://sonarcloud.io/dashboard?id=Goopil_clusterkit)
[![Coverage](https://codecov.io/gh/Goopil/clusterkit/graph/badge.svg)](https://codecov.io/gh/Goopil/clusterkit)
[![npm version](https://img.shields.io/npm/v/@goopil/clusterkit.svg?label=%40goopil%2Fclusterkit)](https://www.npmjs.com/package/@goopil/clusterkit)
[![npm downloads](https://img.shields.io/npm/dm/@goopil/clusterkit.svg)](https://www.npmjs.com/package/@goopil/clusterkit)

Production-ready Node.js cluster orchestrator for multi-core HTTP servers in containers. Bring your own web
framework — ClusterKit handles worker lifecycle, kernel-level load balancing, crash recovery, and graceful
shutdown so you don't have to.

**Why clusterkit?**

- **Kernel-level load balancing** via `SO_REUSEPORT` detection — workers bind directly to the same port and let
  the Linux kernel distribute connections (no primary-as-proxy bottleneck).
- **Container-native** — reads cgroup v1/v2 CPU and memory limits to size workers automatically, with
  per-worker `--max-old-space-size` injection.
- **Production-grade shutdown** — per-worker ACK protocol with configurable timeouts and `SIGTERM → SIGINT →
  SIGKILL` escalation, tuned to fit inside a Kubernetes `terminationGracePeriodSeconds` budget.
- **Crash resilient** — exponential backoff with a sliding-window circuit breaker prevents infinite crash loops
  from exhausting resources.
- **Framework-agnostic** — works with Express, Fastify, Hono, Koa, NestJS, and more (8 ready-to-run examples).
- **Zero runtime dependencies** — the core package ships only TypeScript types and ESM/CJS bundles.

**What this provides:**

- Automatic worker spawning with SO_REUSEPORT detection (kernel-level load balancing on Linux)
- Crash recovery with exponential backoff and a configurable circuit breaker
- Graceful shutdown with per-worker ACK protocol and configurable timeouts
- Worker age recycling, health checks, and typed EventEmitter events
- A plugin system for first-party and third-party extensions

**What this does NOT provide:**

- Request routing or proxying — workers bind directly via SO_REUSEPORT or via Node.js cluster IPC
- A web framework — bring your own (Express, Fastify, Hono, Koa, NestJS, …)
- A process manager — designed to run inside an existing container / systemd unit

## Packages

| Package                                   | Description                                               | Detailed docs |
|-------------------------------------------|-----------------------------------------------------------|---------------|
| [`@goopil/clusterkit`](#goopilclusterkit) | Cluster orchestrator — core library                       | [`packages/worker-manager/README.md`](./packages/worker-manager/README.md) |
| [`@goopil/clusterkit-prometheus`](#goopilclusterkit-prometheus) | Prometheus metrics export plugin                          | [`packages/plugin-prometheus/README.md`](./packages/plugin-prometheus/README.md) |
| [`@goopil/clusterkit-sizing`](#goopilclusterkit-sizing) | Kubernetes / container-aware CPU and memory sizing plugin | [`packages/plugin-container-sizing/README.md`](./packages/plugin-container-sizing/README.md) |
| [`@goopil/clusterkit-otlp-meter`](#goopilclusterkit-otlp-meter) | OpenTelemetry OTLP metrics export plugin                  | [`packages/plugin-otlp-meter/README.md`](./packages/plugin-otlp-meter/README.md) |
| [`@goopil/clusterkit-signal-restart`](#goopilclusterkit-signal-restart) | Signal-based hot restart plugin (SIGHUP → rolling restart) | [`packages/plugin-signal-restart/README.md`](./packages/plugin-signal-restart/README.md) |
| [`@goopil/clusterkit-file-watcher`](#goopilclusterkit-file-watcher) | File watcher hot restart plugin (file/env changes → rolling restart) | [`packages/plugin-file-watcher/README.md`](./packages/plugin-file-watcher/README.md) |

This root README gives the monorepo overview. Each package also has a dedicated README focused on its own capabilities,
options, and API surface.

---

## `@goopil/clusterkit`

Detailed package README: [`packages/worker-manager/README.md`](./packages/worker-manager/README.md)

### Installation

```bash
pnpm add @goopil/clusterkit
```

### Quick start

```js
import {Orchestrator} from '@goopil/clusterkit';

// Create the orchestrator explicitly, then query capabilities when needed
const orchestrator = new Orchestrator({logger: console});

orchestrator.run(async () => {
  const capabilities = await Orchestrator.getCapabilities();

  // Start your HTTP server here — this callback runs in every worker
  const server = createServer(/* ... */);

  server.listen({
    port: 3000,
    host: '0.0.0.0',
    // On Linux with SO_REUSEPORT: each worker binds directly (kernel balances)
    // On macOS / without SO_REUSEPORT: cluster IPC handles distribution
    reusePort: capabilities.reusePort,
    exclusive: capabilities.reusePort,
  });

  // Register a graceful shutdown callback
  orchestrator.registerOnShutdown(() => server.close());
});
```

### Worker count

| Condition                                        | Workers spawned             |
|--------------------------------------------------|-----------------------------|
| `workers.count: 'auto'` + `WEB_CONCURRENCY` set | Value of `WEB_CONCURRENCY`  |
| `workers.count: 'auto'` + SO_REUSEPORT available | `os.availableParallelism()` |
| `workers.count: 'auto'` + no SO_REUSEPORT        | `os.availableParallelism()` with cluster round-robin |
| `workers.count: N`                               | Exactly N workers           |

> **macOS note** — SO_REUSEPORT detection is unreliable on macOS. Use `WEB_CONCURRENCY=4` to force multi-worker mode, or
> test on Linux with the [Docker harness](#docker-test-harness).

### Configuration

```ts
const orchestrator = new Orchestrator({
    logger: null, // pino/winston/console-compatible logger, null = silent

    workers: {
      count: 'auto', // number | 'auto' — worker count
      env: {NODE_ENV: 'production'}, // env vars injected into each worker
      execArgv: ['--max-old-space-size=512'],
      maxAgeMs: 0, // worker recycling (0 = disabled)
    },

    restart: {
      crashThreshold: 5, // crashes before stopping restarts
      crashWindowMs: 60_000, // sliding window for crash counting
      backoffMs: 1_000, // initial restart delay
      maxBackoffMs: 30_000, // upper bound for restart delay
      backoffMultiplier: 2, // exponential multiplier after each crash
      stabilityWindowMs: 30_000, // reset backoff only after this crash-free window (0 = immediate reset)
    },

    shutdown: {
      timeoutMs: 12_000, // graceful shutdown timeout before force kill
      ackTimeoutMs: 3_000,
      messagePrefix: '__wm',
      sigtermDelayMs: 2_000,
      sigintDelayMs: 1_000,
    },
});
```

Backoff resets are stability-based: the delay returns to the initial value only after a crash-free period of
`restart.stabilityWindowMs`.

> **Security defaults** — `workers.execArgv` rejects code-loading/debug flags (`--require`/`-r`, `--eval`/`-e`,
> `--print`/`-p`, `--inspect`/`--inspect-brk`/`--inspect-port`, `--import`, `--loader`/`--experimental-loader`),
> because a JSON/YAML config could otherwise carry remote code into workers. `workers.env` rejects
> `__proto__`/`constructor`/`prototype` keys in every env path (config, `patchWorkerEnv()`, restart env overlay), and
> a `NODE_OPTIONS` entry in `workers.env` triggers a `ClusterKitSecurityWarning` advisory since it can bypass the
> `execArgv` blocklist. See the [core README](./packages/worker-manager/README.md) for details.

### API

```ts
// Construction + static platform helpers
const orchestrator = new Orchestrator(config);
const supports = await Orchestrator.supportsReusePort();
const caps = await Orchestrator.getCapabilities();

// Entry point
orchestrator.run(start);                 // runs primary or worker logic
orchestrator.use(plugin);               // register a plugin (chainable)
orchestrator.registerOnShutdown(cb);    // called in each worker before exit

// Observability
orchestrator.getMetrics();              // WorkerMetrics snapshot
orchestrator.getHealth();               // { ready: boolean, live: boolean }
orchestrator.setNotReady();             // mark ready=false (e.g. during rolling deploys)
orchestrator.setReady();                // restore ready=true (no-op during shutdown)
orchestrator.resetCircuitBreaker();     // re-arm after a crash-loop trip; refills missing workers
orchestrator.restartWorkers(opts);     // rolling-restart workers without dropping connections
orchestrator.workerCount;               // resolved worker count (number)

// restartWorkers opts: { env?: NodeJS.ProcessEnv, filter?: (id: number) => boolean, staggerMs?: number, reason?: string }

// Plugin helpers — available to plugins during install(), throw once workers are forked
orchestrator.patchWorkerEnv(env);       // merge additional env vars into workerEnv (chainable)
orchestrator.overrideWorkerCount(n);    // change worker count when configured as 'auto' (chainable, max 256)
```

### Events

```ts
orchestrator.on('worker:online', ({workerId, pid}) => {
});
orchestrator.on('worker:crash', ({workerId, pid, code, signal}) => {
});
orchestrator.on('worker:restart', ({newWorkerId, newPid}) => {
});
orchestrator.on('worker:recycle', ({workerId, pid, ageMs}) => {
});
orchestrator.on('shutdown:start', ({signal}) => {
});
orchestrator.on('shutdown:complete', ({metrics}) => {
});
orchestrator.on('circuit-breaker:tripped', ({crashCount, windowMs}) => {
});
orchestrator.on('restart:start', ({reason, workerIds}) => {
});
orchestrator.on('restart:complete', ({restartedWorkerIds, reason}) => {
});
```

### Graceful shutdown

The orchestrator intercepts `SIGTERM` and `SIGINT` on the primary process and coordinates a clean shutdown:

1. Sends an IPC shutdown message to all workers
2. Waits for each worker to ACK, exit, or disconnect (max `shutdown.ackTimeoutMs` per worker)
3. Calls `worker.disconnect()` on all workers
4. Waits up to `shutdown.timeoutMs` for workers to exit cleanly
5. Force-kills any remaining workers (`SIGTERM` → `SIGINT` → `SIGKILL`)
6. Calls `plugin.uninstall()` on all registered plugins
7. Exits the primary with code `0`

`SIGHUP` is logged but ignored. If you need rolling restart functionality (e.g. for zero-downtime deployments on bare metal), use a dedicated plugin instead.

ACK is the preferred cooperative signal, but a worker that terminates before sending ACK is also treated as complete for
that ACK wait. This keeps container shutdown predictable when an application closes quickly or the process exits during
its own cleanup path.

`shutdown.timeoutMs` is the global graceful budget after the disconnect phase starts. Tune it to be lower than your
orchestrator's termination grace period (for example Kubernetes `terminationGracePeriodSeconds`) so ClusterKit still has
time to escalate from `SIGTERM` to `SIGINT` and finally `SIGKILL` if a worker hangs.

In each worker, the shutdown sequence is:

1. Receives IPC message (or `SIGTERM`/`SIGINT`)
2. Sends ACK to primary
3. Calls your `registerOnShutdown()` callback (e.g. `server.close()`)
4. Exits with code `0`

### Circuit breaker

If workers crash more than `crashThreshold` times within `crashWindowMs`, the orchestrator stops restarting them and
emits `circuit-breaker:tripped`. This prevents infinite crash loops that would otherwise exhaust system resources.

### Health checks

```ts
const health = orchestrator.getHealth();
// { ready: boolean, live: boolean }

// live becomes false when primary is running but has zero active workers
// ready becomes false during shutdown or when setNotReady() is called
```

Use these with your Kubernetes liveness / readiness probes.

---

## `@goopil/clusterkit-prometheus`

Detailed package README: [`packages/plugin-prometheus/README.md`](./packages/plugin-prometheus/README.md)

Exports cluster metrics via [prom-client](https://github.com/siimon/prom-client).

### Installation

```bash
pnpm add @goopil/clusterkit-prometheus prom-client
```

### Usage

```js
import cluster from 'node:cluster';
import http from 'node:http';
import {Orchestrator} from '@goopil/clusterkit';
import {createPrometheusPlugin} from '@goopil/clusterkit-prometheus';

const orchestrator = new Orchestrator({logger: console});

const prometheus = createPrometheusPlugin({
  prefix: 'clusterkit_',
  metricsCacheTtlMs: 250, // cache merged metrics for short scrape bursts
  defaultMetrics: true,  // collect Node.js process metrics from workers only
});

if (cluster.isPrimary) {
  const metricsServer = http.createServer(async (req, res) => {
    if (req.url !== '/metrics' || req.method !== 'GET') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    res.setHeader('Content-Type', prometheus.registry.contentType);
    res.end(await prometheus.getMetrics());
  });

  metricsServer.listen(9090, '127.0.0.1');
}

orchestrator
  .use(prometheus)
  .run(async () => { /* your app */
  });
```

The plugin starts automatically when `orchestrator.run()` is called and shuts down cleanly with the orchestrator.

### Options

| Option              | Type                               | Default          | Description                                                        |
|---------------------|------------------------------------|------------------|--------------------------------------------------------------------|
| `prefix`            | `string`                           | `'clusterkit_'`  | Metric name prefix                                                 |
| `registry`          | `Registry`                         | `new Registry()` | Custom prom-client registry                                        |
| `defaultMetrics`    | `boolean`                          | `true`           | Collect Node.js default process metrics from workers only          |
| `metricsCacheTtlMs` | `number`                           | `1000`           | Cache TTL in ms for merged metrics responses (`0` disables cache). |
| `labels`            | `Record<string, string \| number>` | `{}`             | Static labels added to every metric (pid is always included)       |

### Metrics exposed

| Metric                                       | Type    | Description                        |
|----------------------------------------------|---------|------------------------------------|
| `clusterkit_active_workers`              | Gauge   | Number of currently active workers |
| `clusterkit_worker_restarts_total`       | Counter | Total worker restarts since start  |
| `clusterkit_worker_crashes_total`        | Counter | Total worker crashes since start   |
| `clusterkit_circuit_breaker_trips_total` | Counter | Total circuit breaker trips        |

### Architecture

The plugin uses a two-registry model to separate concerns:

- **Orchestration registry** (primary only) — tracks `active_workers`, restarts, crashes, and circuit breaker trips by
  listening to orchestrator events. It does not collect Node.js process default metrics.
- **`AggregatorRegistry`** (prom-client built-in) — each worker collects its own Node.js default metrics and the primary
  harvests them all via the built-in cluster IPC channel.

Use `prometheus.getMetrics()` from your own HTTP stack to expose `/metrics` (or any custom route).

When `metricsCacheTtlMs > 0`, merged responses are cached in-memory for the configured TTL to reduce repeated
aggregation cost during scrape bursts.

### Exposure and security

- The plugin does not open sockets; the host application controls bind address, auth, TLS, and network policy.
- Prefer binding metrics to `127.0.0.1` or a private service network unless a scrape endpoint must be reachable outside
  the host.
- Treat `/metrics` as operationally sensitive: it can reveal process, topology, runtime, and workload information.
- In Kubernetes, expose metrics through a private `Service` and protect it with `NetworkPolicy`, service mesh policy, or
  ingress rules rather than publishing it directly on a public route.

### API

```ts
prometheus.registry       // prom-client Registry instance (orchestration metrics, primary)
prometheus.getMetrics()   // Promise<string> — Prometheus text format (merged)
```

---

## `@goopil/clusterkit-sizing`

Detailed package README: [`packages/plugin-container-sizing/README.md`](./packages/plugin-container-sizing/README.md)

Reads CPU and memory limits from Linux cgroups (v1 and v2), then automatically configures the optimal number of workers
and injects `--max-old-space-size` into each worker's `NODE_OPTIONS`.

This plugin is primarily intended for Kubernetes pods, Docker containers, and any environment where CPU/memory limits
are enforced at the OS level. On bare metal or macOS, it falls back to OS-level resources.

### Installation

```bash
pnpm add @goopil/clusterkit-sizing
```

### Usage

```js
import {Orchestrator} from '@goopil/clusterkit';
import {createContainerSizingPlugin} from '@goopil/clusterkit-sizing';
import {createPrometheusPlugin} from '@goopil/clusterkit-prometheus';

const orchestrator = new Orchestrator({logger: console});

const sizing = createContainerSizingPlugin();
const prometheus = createPrometheusPlugin({
  metricsCacheTtlMs: 250,
});

orchestrator
  .use(sizing)
  .use(prometheus)
  .run(async () => { /* your app */
  });
```

After `run()` is called, inspect what the plugin decided:

```js
console.log(sizing.sizing);
// {
//   workers: 4,
//   memoryPerWorkerMb: 192,
//   v8HeapMb: 144,
//   nodeOptions: '--max-old-space-size=144',
//   source: { cpuLimit: 4, memoryLimitBytes: 805306368, osCpus: 8, osTotalMemoryBytes: ... }
// }
```

### Options

| Option                 | Type                                          | Default      | Description                                                                                                                                       |
|------------------------|-----------------------------------------------|--------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `overrideWorkerCount`  | `boolean`                                     | `true`       | Set worker count from cgroup CPU limit. Skipped if `workers` was set to an explicit number.                                                       |
| `injectNodeOptions`    | `boolean`                                     | `true`       | Inject `--max-old-space-size` into each worker's `NODE_OPTIONS`.                                                                                  |
| `fallback`             | `boolean`                                     | `true`       | Fall back to OS CPU/memory when no cgroup limits are detected (e.g. on macOS or bare metal). Set to `false` to skip sizing entirely in that case. |
| `strategy`             | `'balanced' \| 'cpu-first'`                   | `'balanced'` | Worker count strategy (see below).                                                                                                                |
| `memoryOverheadFactor` | `number`                                      | `0.80`       | Fraction of total memory allocated to workers (remaining reserved for OS/buffers).                                                                |
| `heapRatio`            | `number`                                      | `0.75`       | Fraction of per-worker memory allocated to the V8 old-generation heap.                                                                            |
| `minWorkers`           | `number`                                      | `1`          | Minimum number of workers regardless of CPU limit. Must stay within `1..256`.                                                                    |
| `maxWorkers`           | `number`                                      | `64`         | Maximum number of workers regardless of CPU limit. Must stay within `1..256` and be `>= minWorkers`.                                             |
| `extraNodeOptions`     | `string`                                      | —            | Additional flags appended to `NODE_OPTIONS` (e.g. `'--experimental-vm-modules'`).                                                                 |

### Strategies

| Strategy       | Behaviour                                                                                    |
|----------------|----------------------------------------------------------------------------------------------|
| `balanced`     | Workers = `floor(cpuLimit)`, stepped down until each worker has at least 128 MB of heap (default) |
| `cpu-first`    | Full CPU count regardless of memory; heap clamped to the 128 MB viability floor (`constrained: true`) |

### How it works

1. **Cgroup detection** — reads `/sys/fs/cgroup/cgroup.controllers` to distinguish v2 from v1, then resolves the
   process cgroup path from `/proc/self/cgroup` before reading controller files. If the resolved path is unavailable,
   it falls back to the canonical `/sys/fs/cgroup/...` locations (`cpu.max` / `memory.max` for v2,
   `cpu.cfs_quota_us` / `memory.limit_in_bytes` for v1).
2. **Sizing calculation** — computes `workers`, `memoryPerWorkerMb`, and `v8HeapMb` from the detected limits and your
   chosen strategy.
3. **Worker count override** — calls `orchestrator.overrideWorkerCount(n)` only if the config
   is `workers.count: 'auto'`. Explicit `workers.count: N` in the config is always respected.
4. **NODE_OPTIONS injection** — calls `orchestrator.patchWorkerEnv({ NODE_OPTIONS: '...' })`, merging with any existing
   `NODE_OPTIONS` in `workerEnv` config or `process.env`. An existing `--max-old-space-size` flag is replaced, not
   duplicated.

The plugin is primary-only and runs entirely inside `install()`, before any worker is forked.

---

## `@goopil/clusterkit-otlp-meter`

Detailed package README: [`packages/plugin-otlp-meter/README.md`](./packages/plugin-otlp-meter/README.md)

OpenTelemetry OTLP metrics plugin that exports orchestration metrics (active workers,
restarts, crashes, circuit-breaker trips) and optional host/process metrics via OTLP/HTTP
or OTLP/gRPC to a collector.

```bash
pnpm add @goopil/clusterkit-otlp-meter @opentelemetry/exporter-metrics-otlp-http
```

```ts
import {createOtlpMeterPlugin} from '@goopil/clusterkit-otlp-meter';

const otlp = createOtlpMeterPlugin({
  endpoint: 'http://otel-collector:4318/v1/metrics',
  serviceName: 'my-app',
});
```

---

## `@goopil/clusterkit-signal-restart`

Detailed package README: [`packages/plugin-signal-restart/README.md`](./packages/plugin-signal-restart/README.md)

Triggers a rolling worker restart on `SIGHUP` (or a custom signal) without dropping connections.

### Installation

```bash
pnpm add @goopil/clusterkit-signal-restart
```

### Usage

```js
import { Orchestrator } from '@goopil/clusterkit';
import { createSignalRestartPlugin } from '@goopil/clusterkit-signal-restart';

const orchestrator = new Orchestrator({ logger: console });

orchestrator
  .use(createSignalRestartPlugin())  // SIGHUP → rolling restart
  .run(async () => { /* ... */ });
```

Send `kill -HUP <pid>` to trigger a rolling restart.

---

## `@goopil/clusterkit-file-watcher`

Detailed package README: [`packages/plugin-file-watcher/README.md`](./packages/plugin-file-watcher/README.md)

Watches source files, `.env` files, and `process.env` for changes and triggers a rolling worker restart.

### Installation

```bash
pnpm add @goopil/clusterkit-file-watcher
```

### Usage

```js
import { Orchestrator } from '@goopil/clusterkit';
import { createFileWatcherPlugin } from '@goopil/clusterkit-file-watcher';

const orchestrator = new Orchestrator({ logger: console });

orchestrator
  .use(createFileWatcherPlugin({
    watch: ['./src'],    // source file changes
    envFile: './.env',  // .env file changes
    debounceMs: 300,
  }))
  .run(async () => { /* ... */ });
```

## Plugin system

Extend the orchestrator with custom plugins:

```ts
import type {OrchestratorPlugin, Orchestrator} from '@goopil/clusterkit';

const myPlugin: OrchestratorPlugin = {
    name: 'my-plugin',

    async install(orchestrator: Orchestrator) {
        // Runs on the primary before workers are forked.
        // Use orchestrator.patchWorkerEnv() or orchestrator.overrideWorkerCount()
        // to influence worker configuration.
        orchestrator.on('worker:crash', ({workerId}) => {
            // send alert, update dashboard, etc.
        });
    },

    async uninstall(orchestrator: Orchestrator) {
        // cleanup — called automatically during shutdown
    },
};

orchestrator.use(myPlugin).run(/* ... */);
```

`use()` is chainable and plugins are installed in registration order.

**Plugin helpers available in `install()`:**

```ts
// install(orchestrator, logger, config) receives the ResolvedConfig —
// read config.workers.count / config.workers.env for the current settings.
orchestrator.patchWorkerEnv(env)        // merge env vars into workerEnv
orchestrator.overrideWorkerCount(n)     // override an 'auto' worker count (max 256)
```

Plugins install **before** the initial fork, so both helpers apply to the whole
fleet. They throw if called after workers have been forked.

---

## Examples

Nine ready-to-run examples live in [`examples/`](./examples/).

| Example                      | Port  | Metrics port | Description |
|------------------------------|-------|--------------|-------------|
| `examples/express`           | 3000  | 9090         | Express HTTP server |
| `examples/express-otlp`      | 3009  | —            | Express + OTLP metrics (push to collector) |
| `examples/fastify`           | 3001  | 9091         | Fastify HTTP server |
| `examples/hono`              | 3005  | 9092         | Hono HTTP server |
| `examples/koa`               | 3006  | 9093         | Koa HTTP server |
| `examples/nestjs-express`    | 3007  | —            | NestJS (Express adapter) |
| `examples/nestjs-fastify`    | 3008  | —            | NestJS (Fastify adapter) |
| `examples/inertia-ssr`       | 13714 | —            | Inertia + Vue 3 SSR renderer |
| `examples/inertia-ssr-react` | 13715 | —            | Inertia + React 18 SSR renderer |
| `examples/hot-reload`        | 3010  | —            | Signal-based + file watcher hot restart demo |

**Run all examples at once (Docker):**

```bash
pnpm examples:start
# All servers start inside a single container.
# curl http://localhost:3000      → Express app
# curl http://localhost:9090/metrics → Prometheus metrics (binds METRICS_HOST, default 0.0.0.0)
```

**Run a single example locally:**

```bash
cd examples/fastify
pnpm install
pnpm start
```

### NestJS + SO_REUSEPORT

NestJS requires a specific lifecycle to bind the raw server socket with `reusePort`:

**Express adapter:**

```ts
// app.init() registers NestJS routes on the Express app without calling listen()
await app.init();
// Then bind the raw http.Server directly so we can pass reusePort
app.getHttpServer().listen({port: 3007, host: '0.0.0.0', reusePort: true, exclusive: true});
```

**Fastify adapter:**

```ts
await app.init();
// app.init() does NOT call fastify.ready() — hook graph must be compiled explicitly
const fastify = app.getHttpAdapter().getInstance();
await fastify.ready();
fastify.server.listen({port: 3008, host: '0.0.0.0', reusePort: true, exclusive: true});
```

### Inertia SSR server

`examples/inertia-ssr` is a drop-in replacement for `@inertiajs/server`, managed by ClusterKit. It exposes the same HTTP protocol that Laravel calls to render Inertia pages server-side, with full multi-worker support via SO_REUSEPORT.

**Build and start:**

```bash
cd examples/inertia-ssr
pnpm install
pnpm build   # vite build --ssr → dist/server/entry-server.mjs
pnpm start   # ClusterKit starts N workers, each listening on 127.0.0.1:13714
```

**Configure Laravel** to point at this server instead of the default one:

```php
// config/inertia.php
'ssr' => [
    'enabled' => true,
    'url' => 'http://127.0.0.1:13714',
],
```

**Test without Laravel:**

```bash
curl -s -X POST http://127.0.0.1:13714/render \
  -H "Content-Type: application/json" \
  -d '{"component":"Home","props":{"pid":1,"hostname":"local"},"url":"/"}'
```

**Adding pages:** drop `.vue` files in `src/Pages/`, rebuild with `pnpm build`, then restart. Laravel components are referenced by name (e.g. `Home` → `src/Pages/Home.vue`).

---

## Development

This repository is a [pnpm](https://pnpm.io) monorepo managed with [Turborepo](https://turbo.build).

```bash
pnpm build           # build all packages (in dependency order)
pnpm test            # run all test suites in parallel
pnpm test:coverage   # run tests with coverage reports
pnpm dev             # watch mode for all packages
pnpm clean           # delete all dist/ and coverage/ directories
```

To run a single package:

```bash
pnpm --filter @goopil/clusterkit test
pnpm --filter @goopil/clusterkit-prometheus build
pnpm --filter @goopil/clusterkit-sizing test
```

---

## Platform support

| Feature                              | Linux | macOS                           |
|--------------------------------------|-------|---------------------------------|
| SO_REUSEPORT (kernel load balancing) | Yes   | Unreliable                      |
| Multi-worker mode                    | Yes   | Requires `WEB_CONCURRENCY`      |
| Graceful shutdown                    | Yes   | Yes                             |
| Circuit breaker                      | Yes   | Yes                             |
| Prometheus metrics                   | Yes   | Yes                             |
| cgroup CPU/memory limits             | Yes   | No (falls back to OS resources) |

On macOS, set `WEB_CONCURRENCY=<n>` to force multi-worker mode, or use the Docker harness below to test on a real Linux
kernel.

---

## Docker

### Test harness

Tests run on macOS may produce different results from Linux (e.g. SO_REUSEPORT behaviour). Use the Docker harness to run
the full test suite on a real Linux kernel:

```bash
pnpm test:linux
```

This builds a `node:25-slim` image, installs dependencies, builds all packages, and runs the complete test suite.

```bash
# Manual equivalents
docker compose build               # pre-build the image
docker compose run --rm test       # run tests without rebuilding
```

### Run all examples

```bash
pnpm examples:start
# Equivalent to: docker compose up examples --build
```

All 6 example servers start inside a single container with their ports mapped to the host (3000–3001, 3005–3008 for
apps; 9090–9093 for metrics).

### Benchmarks

The `benchmarks/` package compares clusterkit against other Node.js process orchestrators (native cluster, throng, pm2)
on 3 HTTP workloads. Results are written to `benchmarks/results/` (`latest.json` + auto-generated `REPORT.generated.md`);
`BENCHMARKS.md` at the repo root is hand-maintained.

```bash
pnpm bench:docker                                                      # full suite, Docker (~36 min)
pnpm bench                                                             # full suite, local
pnpm --filter benchmarks exec node runner.mjs --quick                  # quick mode (~8 min)
pnpm --filter benchmarks exec node runner.mjs --target clusterkit-3   # single target
pnpm --filter benchmarks smoke                                         # boot check, no perf
```

See [`benchmarks/README.md`](./benchmarks/README.md) for the target/workload contract and CLI flags.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License

Licensed under the [GNU Lesser General Public License v3.0](./LICENSE).

You may use this library in proprietary applications without requiring your application to be open source. Modifications
to the library itself must be shared under the same LGPL terms.
