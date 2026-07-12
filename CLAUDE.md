# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package manager

Use **`corepack pnpm`** — `pnpm` is not in PATH directly.

```bash
corepack enable pnpm     # one-time setup
corepack pnpm install    # install all workspace deps
```

## Packages

| Package | Scope | Path |
|---|---|---|
| worker-manager | `@goopil/clusterkit` | `packages/worker-manager/` |
| plugin-prometheus | `@goopil/clusterkit-prometheus` | `packages/plugin-prometheus/` |
| plugin-container-sizing | `@goopil/clusterkit-sizing` | `packages/plugin-container-sizing/` |

## Key commands

```bash
# Build all packages (respects turbo dependency order)
corepack pnpm build

# Build a single package
corepack pnpm --filter @goopil/clusterkit build
corepack pnpm --filter @goopil/clusterkit-prometheus build

# Run tests
corepack pnpm test                                          # all packages via turbo
corepack pnpm --filter @goopil/clusterkit test         # single package
corepack pnpm --filter @goopil/clusterkit-prometheus test

# Run a single test file
corepack pnpm --filter @goopil/clusterkit exec vitest run test/orchestrator.test.ts

# Watch mode
corepack pnpm --filter @goopil/clusterkit test:watch

# Coverage
corepack pnpm --filter @goopil/clusterkit test:coverage

# Linux test harness (SO_REUSEPORT, full suite on real kernel)
corepack pnpm test:linux           # docker compose run --build --rm test

# Start all examples in Docker
corepack pnpm examples:start       # docker compose up examples --build
```

## Architecture

### worker-manager

`Orchestrator` extends `EventEmitter<OrchestratorEvents>` (typed events). Key source files:

- `src/orchestrator.ts` — `Orchestrator` class. Spawns/restarts workers, single-worker mode, circuit breaker (`resetCircuitBreaker()`), restart queue.
- `src/worker-manager.ts` — `WorkerManager`: fork, tracking, age-based recycling
- `src/shutdown-coordinator.ts` — `ShutdownCoordinator`: graceful shutdown sequence (SIGTERM → SIGINT → SIGKILL escalation with ACK protocol)
- `src/signal-handler.ts` — POSIX signal registration/cleanup
- `src/types.ts` — all exported types (`OrchestratorConfig`, `OrchestratorEvents`, `WorkerMetrics`, `HealthStatus`, `Logger`, `OrchestratorPlugin`)
- `src/platform.ts` — `getPlatformCapabilities()` detects SO_REUSEPORT via a two-socket same-port bind probe (a single bind is a false positive on Node < 22.12)
- `src/sizing.ts` / `src/cgroup.ts` — CPU count and cgroup limits for `workers: 'auto'`
- `src/crash-tracker.ts` — sliding-window crash counter for the circuit breaker
- `src/validation.ts` — validates config and applies defaults → `ResolvedConfig`
- `src/index.ts` — public API barrel (re-exports by category)

Plugin install order matters: `run()` installs plugins **before** resolving the worker count and forking (so `overrideWorkerCount` / `patchWorkerEnv` from a plugin apply to the initial fleet). Plugins are installed in worker processes too. `patchWorkerEnv` / `overrideWorkerCount` throw once workers have been forked.

Use `new Orchestrator(config)` as the single creation path. Use `Orchestrator.getCapabilities()` / `Orchestrator.supportsReusePort()` when you need explicit platform capability insight.

`ResolvedConfig` mirrors `OrchestratorConfig` with all defaults applied; `workers.env`, `workers.execArgv` and `clusterModule` stay `| undefined` (no meaningful default).

Dual ESM+CJS build via **tsup**. Tests in `test/` mirror source modules.

### plugin-prometheus

Single file: `packages/plugin-prometheus/src/index.ts`

Two-registry model:
1. **Orchestration registry** — `Counter`/`Gauge` metrics on the primary process, driven by orchestrator events (`worker:online`, `worker:crash`, etc.)
2. **`AggregatorRegistry`** (prom-client built-in) — each worker registers `collectDefaultMetrics` in its own `Registry` and calls `AggregatorRegistry.setRegistries([workerRegistry])`. The primary harvests all workers via prom-client's native cluster IPC.

**There is no built-in HTTP server** — the host app exposes the endpoint itself using `plugin.getMetrics()` (see examples). Merged responses are cached (`metricsCacheTtlMs`, default 1000 ms) and degrade to orchestration-only metrics if worker aggregation fails mid-scrape.

### Examples

Six standalone apps in `examples/` — each integrates both packages:

```
examples/express/          port 3000, metrics 9090
examples/fastify/          port 3001, metrics 9091
examples/hono/             port 3005, metrics 9092  (uses createAdaptorServer)
examples/koa/              port 3006, metrics 9093
examples/nestjs-express/   port 3007, metrics 9094  (TypeScript, tsc build)
examples/nestjs-fastify/   port 3008, metrics 9095  (TypeScript, tsc build)
```

NestJS examples require `app.init()` instead of `app.listen()` to bind the raw server with SO_REUSEPORT. Fastify adapter additionally needs `await fastifyInstance.ready()` between `app.init()` and `fastifyInstance.server.listen()` — without it Fastify's hook graph is not compiled and requests crash.

## Test gotchas

- `workers: 1` → single-worker mode (no cluster fork). Crash/restart tests require `workers >= 2`.
- `shutdownTimeoutMs` minimum is **1000 ms** (enforced by validation).
- SO_REUSEPORT is unreliable on macOS — avoid platform-specific assertions in tests; use the Docker harness for Linux-only behaviour.
- `vi.useFakeTimers()` + `vi.runAllTimersAsync()` for shutdown sequence tests.
- Plugin tests: use `new Registry()` per test and `defaultMetrics: false` to avoid global metric pollution.

## Conventions

- `@goopil/clusterkit` has **zero runtime dependencies** (only `devDependencies` / `peerDependencies`).
- All code, comments, and JSDoc must be in **English**.
- Exports are declared in `src/index.ts`; keep them grouped by category.
- `OrchestratorPlugin` interface: required `name` + `install(orchestrator)`, optional `uninstall?(orchestrator)`. Installed in `run()`, uninstalled in `shutdownPrimary()`.
