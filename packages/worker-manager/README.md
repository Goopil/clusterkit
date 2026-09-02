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
| Graceful shutdown | ACK-based worker shutdown, configurable timeouts/signals (`shutdown.*`) |
| Lifecycle controls | Worker recycling (`workers.maxAgeMs`), env patching and worker-count override APIs |
| Observability | Typed events, `getMetrics()`, `getHealth()` |
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

### `workers`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `count` | `number \| 'auto'` | `'auto'` | Number of workers |
| `env` | `NodeJS.ProcessEnv` | `undefined` | Extra env vars merged into worker env (security guards apply, see below) |
| `execArgv` | `string[]` | `undefined` | Node.js args passed to workers (dangerous flags blocked, see below) |
| `maxAgeMs` | `number` | `0` | Worker recycling interval (`0` disables) |

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
| `worker:recycle` | A worker is replaced because `workers.maxAgeMs` is enabled and reached. |
| `shutdown:start` | Primary shutdown coordination starts for `SIGTERM` or `SIGINT`. |
| `shutdown:complete` | Primary shutdown coordination has finished. |
| `circuit-breaker:tripped` | Crash count reached `restart.crashThreshold` inside `restart.crashWindowMs`. |
| `restart:start` | A hot restart cycle begins via `restartWorkers()`. |
| `restart:complete` | A hot restart cycle finishes — all targeted workers replaced. |

## Capability helpers

Use `Orchestrator.getCapabilities()` when startup needs the full platform summary, and
`Orchestrator.supportsReusePort()` when only `SO_REUSEPORT` support matters. Both helpers are asynchronous because
capability detection can probe the runtime platform.

## Related docs

- [Root README](../../README.md)
- [Audit report](../../docs/audit/README.md)