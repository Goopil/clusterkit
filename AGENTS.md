# AGENTS.md

This file applies to the entire repository.

## Purpose

pnpm workspace for `@goopil/clusterkit` and its first-party plugins. Prefer small, surgical changes that preserve the
current package boundaries and public API shape.

## Working rules

- Use `corepack pnpm`, not bare `pnpm` — pnpm is not in PATH directly; corepack provides it.
- Node `>=22.12.0` (see `.nvmrc`); CI matrix tests on Node 22, 24, and 26.
- Always load nvm and switch to the project Node version before running any command:
  `source ~/.nvm/nvm.sh && nvm use` (reads `.nvmrc`). Without this, the shell defaults to Node 20 and tools like
  `tsdown` fail (no native TS support → falls back to `unrun` which is not installed).
- Keep all source code, comments, tests, and docs in English.
- Preserve the monorepo layout. Do not move code between packages unless the task requires it.
- Prefer focused changes in the package that owns the behavior. Avoid cross-package edits unless there is a clear
  contract change.
- Do not add runtime dependencies to `@goopil/clusterkit` (`packages/worker-manager`); it stays runtime-dependency-free
  (devDependencies / peerDependencies only).
- Keep public exports organized in `packages/worker-manager/src/index.ts` by category.
- Tests live under each package's `test/` directory and mirror the source module they cover
  (e.g. `sizing.ts` → `test/sizing.test.ts`).
- If you change a public API, package behavior visible to users, install instructions, or example usage, update
  `README.md` in the same change.

## Repository map

- `packages/worker-manager/`: core orchestrator published as `@goopil/clusterkit`
- `packages/plugin-prometheus/`: Prometheus integration plugin (`@goopil/clusterkit-prometheus`)
- `packages/plugin-container-sizing/`: container-aware sizing plugin (`@goopil/clusterkit-sizing`)
- `packages/plugin-otlp-meter/`: OpenTelemetry OTLP metrics plugin (`@goopil/clusterkit-otlp-meter`)
- `examples/`: standalone framework examples (express, express-otlp, fastify, hono, koa, nestjs-express,
  nestjs-fastify, inertia-ssr, inertia-ssr-react)
- `docker/`: Linux test harness and example container setup
- `scripts/`: `package-smoke-test.mjs` (publint packaging check), `publish-with-oidc.mjs` (release publishing)

## Architecture notes

### Core package

`packages/worker-manager/src/orchestrator.ts` contains the main `Orchestrator` implementation, worker lifecycle
management, graceful shutdown flow, and plugin installation.

Related support modules:

- `worker-manager.ts` — `WorkerManager`: fork, tracking, age-based recycling
- `shutdown-coordinator.ts` — graceful shutdown sequence (SIGTERM → SIGINT → SIGKILL escalation with ACK protocol)
- `signal-handler.ts` — POSIX signal registration/cleanup
- `platform.ts` — platform capability detection, including `SO_REUSEPORT` (two-socket same-port bind probe; a single
  bind is a false positive on Node < 22.12)
- `sizing.ts` / `cgroup.ts` — CPU detection and cgroup v1/v2 limits for `workers: 'auto'`
- `crash-tracker.ts` — sliding-window crash counter / circuit-breaker logic
- `validation.ts` — config validation and defaulting → `ResolvedConfig` (`workers.env`, `workers.execArgv`, and
  `clusterModule` stay `| undefined` — no meaningful default)
- `logger.ts` — logger facade
- `types.ts` — exported types

Use `new Orchestrator(config)` as the single creation path. Query `Orchestrator.getCapabilities()` /
`Orchestrator.supportsReusePort()` explicitly when capability insight is needed.

### Plugin lifecycle

`run()` installs plugins **before** resolving the worker count and forking, so `overrideWorkerCount` /
`patchWorkerEnv` from a plugin apply to the initial fleet. Plugins are installed in worker processes too.
`patchWorkerEnv` / `overrideWorkerCount` throw once workers have been forked. `OrchestratorPlugin` interface: required
`name` + `install(orchestrator)`, optional `uninstall?(orchestrator)` (called in `shutdownPrimary()`).

### Prometheus plugin

`packages/plugin-prometheus/src/index.ts` uses a two-registry approach:

- orchestration metrics (`Counter`/`Gauge`) in the primary process, driven by orchestrator events
- worker metrics aggregated through `prom-client` `AggregatorRegistry` cluster IPC

There is no built-in HTTP server; the host app exposes the endpoint via `plugin.getMetrics()`. When editing plugin
tests, use `new Registry()` per test and `defaultMetrics: false` to avoid global metric pollution and port conflicts.

## Build tooling

- **tsdown** builds each package as dual ESM+CJS (`dist/index.mjs` + `dist/index.cjs` + type declarations).
- **Turborepo** orchestrates tasks; `test` and `test:coverage` depend on `^build` + `build`, so a stale build can cause
  test failures — run `corepack pnpm build` first if you change public exports or types.
- Workspace dependency versions use the `catalog:` protocol, pinned in `pnpm-workspace.yaml`.

## Commands

### Setup

```bash
corepack enable pnpm
corepack pnpm install
```

### Build, test, lint

```bash
corepack pnpm build                  # build all packages (turbo, dependency order)
corepack pnpm test                   # all package tests via turbo
corepack pnpm test:coverage          # tests with coverage
corepack pnpm test:packages          # publint packaging smoke test (CI runs this)
corepack pnpm lint                   # biome check .
corepack pnpm lint:fix              # biome check --write .
corepack pnpm format                 # biome format --write .
```

### Single package / single test

```bash
corepack pnpm --filter @goopil/clusterkit test
corepack pnpm --filter @goopil/clusterkit build
corepack pnpm --filter @goopil/clusterkit exec vitest run test/orchestrator.test.ts
corepack pnpm --filter @goopil/clusterkit test:watch
corepack pnpm --filter @goopil/clusterkit-prometheus test
corepack pnpm --filter @goopil/clusterkit-sizing test
```

### Linux test harness

```bash
corepack pnpm test:linux        # docker compose run --build --rm test (full suite on real Linux kernel)
corepack pnpm examples:start    # docker compose up examples --build (all 8 examples)
```

## Testing guidance

- Start with the narrowest relevant test target, then widen scope if needed.
- `workers: 1` is single-worker mode (no cluster fork); crash/restart behavior needs `workers >= 2`.
- `shutdownTimeoutMs` has a minimum of `1000` ms.
- macOS is unreliable for `SO_REUSEPORT` assertions. Use the Linux Docker harness for Linux-specific behavior.
- Use fake timers (`vi.useFakeTimers()` + `vi.runAllTimersAsync()`) for shutdown/circuit-breaker timing tests.
- For Prometheus plugin tests, prefer isolated registries and disable default metrics unless the test specifically needs
  them.

## CI gate

CI (`.github/workflows/ci.yml`) runs in this order — a change must pass all of it:

1. **Lint** — `pnpm biome check .`
2. **Build** — `pnpm build`
3. **Test** — `pnpm test` on Node 22, 24, and 26
4. **Linux Docker** — `docker compose run --build --rm test` (SO_REUSEPORT)
5. **Packaging** — `pnpm test:packages` + `publint` on each publishable package

## Changesets and releases

- Add a changeset for any PR that changes a package: `corepack pnpm changeset`. Commit the generated `.changeset/*.md`
  with the PR.
- Releases are automated via npm OIDC trusted publishing on merge to `main` — never run `npm publish` manually.
- See `RELEASING.md` for the full flow and one-time bootstrap.

## Examples

Eight standalone apps in `examples/`, each integrating core + plugins:

| Example           | Port  | Metrics port |
|-------------------|-------|--------------|
| express           | 3000  | 9090         |
| fastify           | 3001  | 9091         |
| hono              | 3005  | 9092         |
| koa              | 3006  | 9093         |
| nestjs-express    | 3007  | 9094         |
| nestjs-fastify    | 3008  | 9095         |
| inertia-ssr       | 13714 | 9096         |
| inertia-ssr-react | 13715 | 9097         |

NestJS examples require `app.init()` (not `app.listen()`) to bind the raw server socket with `reusePort`. The Fastify
adapter additionally needs `await fastifyInstance.ready()` between `app.init()` and
`fastifyInstance.server.listen()` — without it Fastify's hook graph is not compiled and requests crash.

## Change guardrails

- Keep package boundaries intact: core orchestration logic belongs in `worker-manager`; integrations belong in plugins
  or examples.
- Keep docs and examples aligned with shipped behavior.
- Avoid speculative abstraction. Match the existing code style and naming.
- When adding exports or types, update the relevant barrel file and adjacent tests.
- When behavior differs by platform, document the assumption in the test or code path you change.

## Before finishing

Run the smallest relevant validation first. For non-trivial changes, prefer this order:

1. package-specific test target
2. package build or workspace build if types/public exports changed
3. `corepack pnpm lint`
4. broader workspace tests if the change crosses package boundaries

If a change affects end-user behavior, confirm whether `README.md`, `CONTRIBUTING.md`, or an example app also needs an
update.
