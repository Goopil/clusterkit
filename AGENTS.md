# AGENTS.md

This file applies to the entire repository.

## Purpose

This repository contains a pnpm workspace for `@goopil/clusterkit` and its first-party plugins. Prefer small, surgical
changes that preserve the current package boundaries and public API shape.

## Working rules

- Use `corepack pnpm`, not bare `pnpm`; the repo documents pnpm via corepack.
- Keep all source code, comments, tests, and docs in English.
- Preserve the current monorepo layout. Do not move code between packages unless the task explicitly requires it.
- Prefer focused changes in the package that owns the behavior. Avoid cross-package edits unless there is a clear
  contract change.
- Do not add runtime dependencies to `@goopil/clusterkit` (`packages/worker-manager`). That package should stay
  runtime-dependency-free.
- Keep public exports organized in `packages/worker-manager/src/index.ts` by category.
- Mirror source/test naming conventions: tests live under each package’s `test/` directory and should track the source
  module they cover.
- If you change a public API, package behavior visible to users, install instructions, or example usage, update
  `README.md` in the same change.

## Repository map

- `packages/worker-manager/`: core orchestrator published as `@goopil/clusterkit`
- `packages/plugin-prometheus/`: Prometheus integration plugin
- `packages/plugin-container-sizing/`: container-aware sizing plugin
- `examples/`: standalone framework examples
- `docker/`: Linux test harness and example container setup

## Architecture notes

### Core package

`packages/worker-manager/src/orchestrator.ts` contains the main `Orchestrator` implementation, worker lifecycle
management, graceful shutdown flow, and plugin installation.

Related support modules:

- `packages/worker-manager/src/platform.ts`: platform capability detection, including `SO_REUSEPORT`
- `packages/worker-manager/src/sizing.ts`: CPU detection and worker-count resolution
- `packages/worker-manager/src/validation.ts`: config validation and defaulting
- `packages/worker-manager/src/crash-tracker.ts`: crash-window / circuit-breaker logic
- `packages/worker-manager/src/types.ts`: exported types

Use `new Orchestrator(config)` as the single creation path. Query `Orchestrator.getCapabilities()` / `Orchestrator.supportsReusePort()` explicitly when capability insight is needed.

### Prometheus plugin

`packages/plugin-prometheus/src/index.ts` uses a two-registry approach:

- orchestration metrics in the primary process
- worker metrics aggregated through `prom-client` cluster support

When editing plugin tests, avoid shared global registries and port conflicts.

## Commands

### Setup

```bash
corepack enable pnpm
corepack pnpm install
```

### Build and test

```bash
corepack pnpm build
corepack pnpm test
corepack pnpm lint
corepack pnpm --filter @goopil/clusterkit test
corepack pnpm --filter @goopil/clusterkit-prometheus test
corepack pnpm --filter @goopil/clusterkit-sizing test
```

### Focused test examples

```bash
corepack pnpm --filter @goopil/clusterkit exec vitest run test/orchestrator.test.ts
corepack pnpm test:linux
```

## Testing guidance

- Start with the narrowest relevant test target, then widen scope if needed.
- `workers: 1` is single-worker mode; crash/restart behavior needs `workers >= 2`.
- `shutdownTimeoutMs` has a minimum of `1000` ms.
- macOS is unreliable for `SO_REUSEPORT` assertions. Use the Linux Docker harness for Linux-specific behavior.
- Use fake timers for shutdown/circuit-breaker timing tests when possible.
- For Prometheus plugin tests, prefer isolated registries and disable default metrics unless the test specifically needs
  them.

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
