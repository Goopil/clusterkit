# `@goopil/clusterkit`

Core orchestrator for multi-worker Node.js servers.

This README focuses on the package-level contract (capabilities, options, API).
For monorepo context and examples catalog, see the [root README](../../README.md).

## Capabilities

| Capability | Details |
|------------|---------|
| Worker orchestration | Spawns and supervises workers with `cluster` |
| Platform capability detection | `Orchestrator.getCapabilities()` reports `platform`, `reusePort` |
| Crash protection | Exponential restart backoff + circuit breaker (`restart.*`) |
| Health & recovery | Worker heartbeats, RSS recycling, wedged-worker detection, fleet health, boot-loop quarantine (`health.*`, `workers.maxRssMb`) |
| Graceful shutdown | ACK-based worker shutdown, configurable timeouts/signals (`shutdown.*`) |
| Lifecycle controls | Worker recycling (`workers.maxAgeMs`), env patching and worker-count override APIs |
| Observability | Typed events, `getMetrics()`, `getHealth()`, `getFleetHealth()` |
| Plugin system | `use(plugin)` with install/uninstall lifecycle |

## Installation

```bash
pnpm add @goopil/clusterkit
```

## Quick start

```ts
import { createServer } from "node:http";
import { Orchestrator } from "@goopil/clusterkit";

const orchestrator = new Orchestrator({ logger: console });

orchestrator.run(async () => {
  const capabilities = await Orchestrator.getCapabilities();

  const server = createServer((_req, res) => {
    res.end("ok");
  });

  server.listen({
    port: 3000,
    host: "0.0.0.0",
    reusePort: capabilities.reusePort,
    exclusive: capabilities.reusePort,
  });

  orchestrator.registerOnShutdown(() => server.close());
});
```

## Configuration options

### Top-level (`OrchestratorConfig`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logger` | `Logger \| null` | `null` | pino/winston/console-compatible logger |
| `workers` | `WorkersConfig` | `{}` | Worker count/process options |
| `restart` | `RestartConfig` | `{}` | Crash handling + restart policy |
| `shutdown` | `ShutdownConfig` | `{}` | Shutdown lifecycle options |
| `health` | `HealthConfig` | `{}` | Worker health monitoring options |

### `workers`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `count` | `number \| 'auto'` | `'auto'` | Number of workers |
| `env` | `NodeJS.ProcessEnv` | `undefined` | Extra env vars merged into worker env (security guards apply, see below) |
| `execArgv` | `string[]` | `undefined` | Node.js args passed to workers (dangerous flags blocked, see below) |
| `maxAgeMs` | `number` | `0` | Worker recycling interval (`0` disables) |
| `maxRssMb` | `number` | `0` | Recycle a worker whose RSS exceeds this value in MB, through the bounded drain (`0` disables). RSS is reported by the health heartbeat, so it requires `health.heartbeatMs > 0` |

A practical container recipe for `maxRssMb`: budget ≈ 70 % × (cgroup memory limit − primary-process overhead) / workers.
Leave headroom because RSS includes V8 overhead that `--max-old-space-size` does not control. On Linux the cgroup limit
is what the container actually gets; `@goopil/clusterkit-sizing` can compute the whole plan for you.

#### Security guards

- **`execArgv` blocklist** — flags that load or execute arbitrary code, attach a debugger, or write diagnostics to disk
  are rejected with a `WorkerManagerValidationError`: `--require`/`-r`, `--eval`/`-e`, `--print`/`-p`,
  `--inspect`/`--inspect-brk`/`--inspect-port`, `--import`, `--loader`/`--experimental-loader`, `--tls-keylog`,
  `--cpu-prof*`, `--heap-prof*`, `--report-*`, `--diagnostic-dir`, and `--redirect-warnings`. Code-loading and
  debug flags are blocked because a JSON/YAML config could otherwise carry remote code into every worker; profiling and
  diagnostic flags are blocked because they silently write files (or leak TLS keys) from every worker.
- **`env` prototype-pollution guard** — the keys `__proto__`, `constructor`, and `prototype` are rejected in every env
  path: the config, `patchWorkerEnv()`, and the `restartWorkers()` env overlay.
- **`NODE_OPTIONS` advisory** — a `NODE_OPTIONS` key in `workers.env` is accepted but emits a
  `ClusterKitSecurityWarning` at validation, because `NODE_OPTIONS` can carry `--require` and bypass the `execArgv`
  blocklist. Avoid it.

### `restart`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `crashThreshold` | `number` | `5` | Crash count before tripping circuit breaker |
| `crashWindowMs` | `number` | `60000` | Sliding window for crash counting |
| `backoffMs` | `number` | `1000` | Initial restart delay |
| `maxBackoffMs` | `number` | `30000` | Backoff upper bound |
| `backoffMultiplier` | `number` | `2` | Exponential backoff multiplier |
| `stabilityWindowMs` | `number` | `30000` | Crash-free time required to reset backoff (`0` = immediate reset) |
| `bootFailQuarantine` | `number` | `0` | Consecutive boot failures (worker exits before its first `online`) before the slot is quarantined — the primary stops re-forking it while other workers serve (`0` disables). Remedy: `restartWorkers()` |

Restart/backoff is cluster-level, not worker-local. Every non-graceful worker exit is recorded in the crash window and
queued for replacement unless shutdown is already in progress or the circuit breaker has tripped. Replacements are
started one at a time through the restart queue, using the current backoff delay. A healthy worker that was not part of
the crash does not reset the delay by itself; backoff resets only after a replacement has stayed online for
`stabilityWindowMs` without another crash. This keeps partial flapping conservative while avoiding a full-cluster stop
unless `crashThreshold` is reached inside `crashWindowMs`.

### `shutdown`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeoutMs` | `number` | `12000` | Max graceful shutdown duration before forced kill |
| `ackTimeoutMs` | `number` | `3000` | Max wait for worker ACK before disconnecting that worker |
| `messagePrefix` | `string` | `"__wm"` | Internal IPC message prefix |
| `sigtermDelayMs` | `number` | `2000` | Delay before escalating `SIGTERM -> SIGINT` |
| `sigintDelayMs` | `number` | `1000` | Delay before escalating `SIGINT -> SIGKILL` |

### `health`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `heartbeatMs` | `number` | `0` | Worker health report (RSS, heap, event-loop lag) interval in ms (`0` disables) |
| `wedgedTimeoutMs` | `number` | `0` | Recycle a worker whose heartbeat has been silent this long (`0` disables). Requires `heartbeatMs > 0` and ≥ 2 × `heartbeatMs` |
| `degradedAfterMs` | `number` | `0` | Duration `active < target` must persist before `fleet:degraded` fires (`0` disables) |

Workers report RSS, heap, and event-loop beat drift over IPC every `heartbeatMs`; the primary-side monitor feeds two
opt-in policies: RSS recycling (`workers.maxRssMb`) and wedged-worker detection (`health.wedgedTimeoutMs`). A wedged
worker cannot ACK anything, so the drain escalates to SIGKILL. Both policies run through the same bounded drain as
age-based recycling and never count toward the crash circuit breaker.

Health features work at every worker count: at `count: 1` a single worker is forked and reports heartbeats over IPC
exactly like a larger fleet. Since 2.0 there is no no-fork mode — the primary is always a supervisor and the app always
runs in a worker process.

## Migration to 2.0

- `workers.count: 1` now forks one worker instead of running the app in the primary. The primary is a pure supervisor:
  OOM/wedge of the app no longer kills the process tree — the worker is restarted with backoff and the crash-loop
  breaker. Budget ~30-50 MB extra RSS for the extra process.
- `orchestrator.isPrimary` is now `false` in the application process at count 1. Gate primary-only resources on
  `isPrimary` as you would in multi-worker mode.
- Health features (heartbeats, RSS recycling, wedged detection, fleet degradation) work at count 1 — the 1.x startup
  warnings are gone.
- SIGHUP (plugin-signal-restart) and file/env watching (plugin-file-watcher) trigger in-process rolling restarts at
  count 1.
- Debugging: attach the inspector to the worker process — Node auto-increments cluster worker inspector ports.

## Runtime API (high level)

```ts
const orchestrator = new Orchestrator(config);

await orchestrator.run(start);
orchestrator.use(plugin); // must be called before run() — throws afterwards
orchestrator.registerOnShutdown(cb);

orchestrator.overrideWorkerCount(4); // capped at 256
orchestrator.patchWorkerEnv({ NODE_OPTIONS: "--max-old-space-size=256" });

const metrics = orchestrator.getMetrics();
const health = orchestrator.getHealth();
const fleet = orchestrator.getFleetHealth(); // { target, active, quarantined, breaker }

orchestrator.isPrimary; // true in the primary (the supervisor), false in forked workers — incl. the app process at count 1

orchestrator.resetCircuitBreaker(); // after fixing a crash-loop cause

const supportsReusePort = await Orchestrator.supportsReusePort();
const capabilities = await Orchestrator.getCapabilities();
```

## Lifecycle and shutdown semantics

The primary process owns worker supervision, restart policy, plugin installation, and coordinated shutdown. Worker
processes only run the application bootstrap passed to `run()` and any shutdown callbacks registered with
`registerOnShutdown()`.

During `SIGTERM` or `SIGINT`, the primary sends a shutdown IPC message to each worker and waits for one terminal outcome:
worker ACK, worker `exit`, worker `disconnect`, or `shutdown.ackTimeoutMs`. It then disconnects remaining workers, waits
up to `shutdown.timeoutMs`, and escalates hung workers through `SIGTERM`, `SIGINT`, then `SIGKILL`.

Register server cleanup in workers, not the primary:

```ts
orchestrator.run(async () => {
  const server = createServer(handler);
  server.listen(3000);

  orchestrator.registerOnShutdown(() => server.close());
});
```

Set `shutdown.timeoutMs` below your platform termination grace period so forced escalation can happen before the
container or process supervisor kills the primary process.

## Typed events (`OrchestratorEvents`)

| Event | When it fires |
|-------|---------------|
| `worker:online` | A worker reaches the cluster online state. |
| `worker:exit` | A worker exits, including graceful disconnects and crashes. |
| `worker:crash` | A worker exits non-gracefully and is recorded in the crash window. |
| `worker:restart` | A replacement worker is forked after restart backoff. |
| `worker:recycle` | A worker is replaced through the bounded drain. `reason` is `"maxAge"` (default), `"rss"` (`workers.maxRssMb` exceeded), or `"wedged"` (heartbeat silent for `health.wedgedTimeoutMs`). |
| `worker:health` | A worker reported health (requires `health.heartbeatMs > 0`): `{ workerId, pid, rss, heapUsed, eventLoopLagMs }`. |
| `worker:wedged` | A worker's heartbeat was silent for `health.wedgedTimeoutMs` — it is recycled through the bounded drain: `{ workerId, pid, silentMs }`. |
| `worker:quarantined` | A slot was quarantined after `restart.bootFailQuarantine` consecutive boot failures while other workers serve: `{ consecutiveBootFailures }`. |
| `fleet:degraded` | `active < target` persisted for `health.degradedAfterMs`: `{ target, active }`. |
| `fleet:recovered` | Capacity restored to target: `{ target, active, degradedDurationMs }`. |
| `shutdown:start` | Primary shutdown coordination starts for `SIGTERM` or `SIGINT`. |
| `shutdown:complete` | Primary shutdown has finished — emitted after user shutdown callbacks and plugin `uninstall()`, in every mode. Plugins doing final work must do it in `uninstall()`: their `shutdown:complete` listener is removed before the event fires. |
| `circuit-breaker:tripped` | Crash count reached `restart.crashThreshold` inside `restart.crashWindowMs`. |
| `restart:start` | A hot restart cycle begins via `restartWorkers()`. |
| `restart:complete` | A hot restart cycle finishes — all targeted workers replaced. |

## Capability helpers

Use `Orchestrator.getCapabilities()` when startup needs the full platform summary, and
`Orchestrator.supportsReusePort()` when only `SO_REUSEPORT` support matters. Both helpers are asynchronous because
capability detection can probe the runtime platform.

## Fleet health, quarantine and recovery

`getFleetHealth()` returns a point-in-time snapshot:

```ts
{ target: 4, active: 3, quarantined: 1, breaker: { count: 2, tripped: false } }
```

- `target` / `active` — configured worker count vs. currently online workers.
- `quarantined` — slots stopped by the boot-loop guard (see below).
- `breaker` — crash-window count and circuit-breaker state.

**Boot-loop quarantine.** A worker that exits without ever reaching `online` is a boot failure. After
`restart.bootFailQuarantine` consecutive boot failures — while the rest of the fleet is still serving — the slot is
quarantined: the primary stops re-forking it instead of burning forks in a loop. Quarantined boot failures write no
crash record, so one bad slot cannot trip the fleet circuit breaker.

**Remedy.** `restartWorkers()` clears the quarantine counters and refills the missing capacity — every slot gets a
fresh boot attempt as part of the roll. `resetCircuitBreaker()` also refills missing capacity but does not clear the
quarantine counters, so `getFleetHealth().quarantined` can over-report while such a refill is already serving the slot.

**Recycle path.** All recycle reasons (`maxAge`, `rss`, `wedged`) share one bounded drain: the replacement is forked
first, then the old worker is retired through IPC shutdown → disconnect → SIGTERM → SIGKILL. RSS and wedged recycles
never count toward the crash circuit breaker.

## Related docs

- [Root README](../../README.md)
- [Audit report](../../docs/audit/README.md)