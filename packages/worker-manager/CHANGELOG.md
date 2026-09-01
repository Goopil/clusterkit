# @goopil/clusterkit

## 1.2.2

### Patch Changes

- [#107](https://github.com/Goopil/clusterkit/pull/107) [`7e71a94`](https://github.com/Goopil/clusterkit/commit/7e71a946657e05adffd8f7a226acd7bbd2a71ec4) Thanks [@Goopil](https://github.com/Goopil)! - Run `registerOnShutdown` callbacks during multi-worker primary shutdown and unref the restart backoff timer, so plugin flushes and cleanups are no longer silently skipped on deploy.

## 1.2.1

### Patch Changes

- [#76](https://github.com/Goopil/clusterkit/pull/76) [`405a32c`](https://github.com/Goopil/clusterkit/commit/405a32c6bd38aa9b0e36d510aaef8fb0077df700) Thanks [@Goopil](https://github.com/Goopil)! - Over-engineering cleanup: remove dead methods and flags (`bypassCache`, `memory-first` strategy, `clusterRecommended`), simplify internals. The shutdown non-ACK warn (previously unreachable) now fires with a worker count.

## 1.2.0

### Minor Changes

- [#70](https://github.com/Goopil/clusterkit/pull/70) [`ccca20b`](https://github.com/Goopil/clusterkit/commit/ccca20be1e456e6968bd6bdde709023cf7aefdbc) Thanks [@Goopil](https://github.com/Goopil)! - Block `--import` and `--loader`/`--experimental-loader` in `workers.execArgv` (RCE bypass of the existing dangerous-flag blocklist).

- [#70](https://github.com/Goopil/clusterkit/pull/70) [`ccca20b`](https://github.com/Goopil/clusterkit/commit/ccca20be1e456e6968bd6bdde709023cf7aefdbc) Thanks [@Goopil](https://github.com/Goopil)! - Fix hot-restart deadlock: bound the wait for the old worker's exit during restartWorkers() and drain it if the replacement dies before coming online.

### Patch Changes

- [#70](https://github.com/Goopil/clusterkit/pull/70) [`ccca20b`](https://github.com/Goopil/clusterkit/commit/ccca20be1e456e6968bd6bdde709023cf7aefdbc) Thanks [@Goopil](https://github.com/Goopil)! - Cap `overrideWorkerCount()` at 256 workers (MAX_AUTO_WORKERS), consistent with the WEB_CONCURRENCY auto-sizing clamp.

- [#70](https://github.com/Goopil/clusterkit/pull/70) [`ccca20b`](https://github.com/Goopil/clusterkit/commit/ccca20be1e456e6968bd6bdde709023cf7aefdbc) Thanks [@Goopil](https://github.com/Goopil)! - Harden worker env handling: reject prototype-pollution keys in every env path (validation, patchWorkerEnv, restart overlay) and warn when workers.env contains NODE_OPTIONS.

## 1.1.1

### Patch Changes

- [#56](https://github.com/Goopil/clusterkit/pull/56) [`ce7df52`](https://github.com/Goopil/clusterkit/commit/ce7df522b8a9844f2e5de314e8013b95b12b5c0b) Thanks [@Goopil](https://github.com/Goopil)! - Fix all 32 open SonarCloud issues: refactor validateConfig to reduce cognitive complexity, fix async signal handler, extract nested ternaries, use Set for dangerous keys, log caught exceptions in platform detection, parameterize duplicate tests, add missing test assertions, and prefer toHaveLength over toBe for array lengths.

## 1.1.0

### Minor Changes

- [#50](https://github.com/Goopil/clusterkit/pull/50) [`7c3a622`](https://github.com/Goopil/clusterkit/commit/7c3a6225729f3d2e1a0e569ce363e00326419921) Thanks [@Goopil](https://github.com/Goopil)! - Add Orchestrator.restartWorkers() for hot rolling restarts without dropping connections

## 1.0.4

### Patch Changes

- [#48](https://github.com/Goopil/clusterkit/pull/48) [`3094a47`](https://github.com/Goopil/clusterkit/commit/3094a470c5dc3d91592c72ce025caa7092841650) Thanks [@Goopil](https://github.com/Goopil)! - Fix uncaught EPIPE error during worker shutdown when a worker exits while the primary is sending the shutdown message or disconnecting the IPC channel.

## 1.0.3

### Patch Changes

- [#40](https://github.com/Goopil/clusterkit/pull/40) [`71e131f`](https://github.com/Goopil/clusterkit/commit/71e131f2f6a4f561c8a5eaa92b1d1d0beb3b8cfd) Thanks [@Goopil](https://github.com/Goopil)! - Expand test coverage with shutdown escalation, worker recycling, crash tracker boundary tests, integration tests, example smoke tests, stress tests, and coverage thresholds

## 1.0.2

### Patch Changes

- [#37](https://github.com/Goopil/clusterkit/pull/37) [`6510eb8`](https://github.com/Goopil/clusterkit/commit/6510eb8fa7f2a27e1eed53d6f446571df7ca7610) Thanks [@Goopil](https://github.com/Goopil)! - Fix axios security advisory (GHSA) by adding a `pnpm.overrides` entry forcing
  `axios >= 1.18.0`. axios was only pulled in as an optional peer dependency of
  `@inertiajs/core` and `laravel-precognition` in the Inertia SSR examples; the
  override ensures no vulnerable version can be resolved and the lockfile no
  longer resolves axios 1.16.0.

## 1.0.1

### Patch Changes

- [#34](https://github.com/Goopil/clusterkit/pull/34) [`2fa3de2`](https://github.com/Goopil/clusterkit/commit/2fa3de24ca6de76d2c677f73dddcc3ff6b9e3f85) Thanks [@Goopil](https://github.com/Goopil)! - Core audit fixes: reject cgroup path traversal via `..` components,
  deduplicate concurrent `detectReusePortSupport` calls, block dangerous
  `execArgv` flags (`--require`, `--eval`, `--inspect`), fix Inertia SSR
  example, deduplicate `withLoggerPrefix` across plugins, pin CI actions
  to SHAs, run Docker containers as non-root.

- [#34](https://github.com/Goopil/clusterkit/pull/34) [`2fa3de2`](https://github.com/Goopil/clusterkit/commit/2fa3de24ca6de76d2c677f73dddcc3ff6b9e3f85) Thanks [@Goopil](https://github.com/Goopil)! - Fix prototype pollution vulnerability in `patchWorkerEnv` by rejecting `__proto__`, `constructor`, and `prototype` keys before merging environment variables.

- [#34](https://github.com/Goopil/clusterkit/pull/34) [`2fa3de2`](https://github.com/Goopil/clusterkit/commit/2fa3de24ca6de76d2c677f73dddcc3ff6b9e3f85) Thanks [@Goopil](https://github.com/Goopil)! - Fix leaked recycled workers by escalating to SIGTERM after 5s and SIGKILL after 2s more, replacing the no-op `disconnect()` retry that left stuck workers alive indefinitely.

- [#36](https://github.com/Goopil/clusterkit/pull/36) [`6060255`](https://github.com/Goopil/clusterkit/commit/6060255be02f1874b32455c5aaca5d4d75ef3258) Thanks [@Goopil](https://github.com/Goopil)! - Update dev and example dependencies to latest patch/minor:
  biome 2.5.3 → 2.5.7, turbo 2.10.4 → 2.10.9, tsdown 0.22.5 → 0.22.14,
  @types/node 26.1.1 → 26.2.0, vite 8.1.4 → 8.2.1, changesets 2.31.0 → 2.31.1,
  nestjs 11.1.28 → 11.1.29, fastify 5.10.0 → 5.11.3, hono 4.12.29 → 4.13.1,
  inertia 3.5.0 → 3.6.1, vue 3.5.39 → 3.5.41. No major bumps.

## 1.0.0

### Patch Changes

- [#5](https://github.com/Goopil/clusterkit/pull/5) [`a3c1aec`](https://github.com/Goopil/clusterkit/commit/a3c1aec3619c9c90ee1ea7d000f164b40e1c7266) Thanks [@Goopil](https://github.com/Goopil)! - Renovate build tool chain and update packages
