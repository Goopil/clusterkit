# @goopil/clusterkit-prometheus

## 0.1.3

### Patch Changes

- [#40](https://github.com/Goopil/clusterkit/pull/40) [`71e131f`](https://github.com/Goopil/clusterkit/commit/71e131f2f6a4f561c8a5eaa92b1d1d0beb3b8cfd) Thanks [@Goopil](https://github.com/Goopil)! - Expand test coverage with shutdown escalation, worker recycling, crash tracker boundary tests, integration tests, example smoke tests, stress tests, and coverage thresholds

- Updated dependencies [[`71e131f`](https://github.com/Goopil/clusterkit/commit/71e131f2f6a4f561c8a5eaa92b1d1d0beb3b8cfd)]:
  - @goopil/clusterkit@1.0.3

## 0.1.2

### Patch Changes

- [#37](https://github.com/Goopil/clusterkit/pull/37) [`6510eb8`](https://github.com/Goopil/clusterkit/commit/6510eb8fa7f2a27e1eed53d6f446571df7ca7610) Thanks [@Goopil](https://github.com/Goopil)! - Fix axios security advisory (GHSA) by adding a `pnpm.overrides` entry forcing
  `axios >= 1.18.0`. axios was only pulled in as an optional peer dependency of
  `@inertiajs/core` and `laravel-precognition` in the Inertia SSR examples; the
  override ensures no vulnerable version can be resolved and the lockfile no
  longer resolves axios 1.16.0.
- Updated dependencies [[`6510eb8`](https://github.com/Goopil/clusterkit/commit/6510eb8fa7f2a27e1eed53d6f446571df7ca7610)]:
  - @goopil/clusterkit@1.0.2

## 0.1.1

### Patch Changes

- [#34](https://github.com/Goopil/clusterkit/pull/34) [`2fa3de2`](https://github.com/Goopil/clusterkit/commit/2fa3de24ca6de76d2c677f73dddcc3ff6b9e3f85) Thanks [@Goopil](https://github.com/Goopil)! - Deduplicate concurrent `getMetrics()` calls via an in-flight promise. When the merged metrics cache expires, concurrent scrapes previously each fanned out a separate IPC `clusterMetrics()` round-trip to all workers, risking a cache stampede under concurrent Prometheus scraping. The plugin now tracks an in-flight collection promise and shares it across concurrent non-bypass calls so only one IPC fan-out occurs at a time.

- [#34](https://github.com/Goopil/clusterkit/pull/34) [`2fa3de2`](https://github.com/Goopil/clusterkit/commit/2fa3de24ca6de76d2c677f73dddcc3ff6b9e3f85) Thanks [@Goopil](https://github.com/Goopil)! - Fix `active_workers` gauge and default metrics collection in single-worker mode. When the orchestrator runs the app directly in the primary without forking (explicit `workers: 1` or `workers: "auto"` resolving to 1 on a single-CPU machine), no `worker:online` event fires, so the gauge stayed at 0 and default process metrics were never collected. The plugin now uses the resolved `orchestrator.workerCount` (not the unresolved config value) to detect single-worker mode and seeds the gauge to 1 + collects default metrics in the primary.

- [#36](https://github.com/Goopil/clusterkit/pull/36) [`6060255`](https://github.com/Goopil/clusterkit/commit/6060255be02f1874b32455c5aaca5d4d75ef3258) Thanks [@Goopil](https://github.com/Goopil)! - Update dev and example dependencies to latest patch/minor:
  biome 2.5.3 → 2.5.7, turbo 2.10.4 → 2.10.9, tsdown 0.22.5 → 0.22.14,
  @types/node 26.1.1 → 26.2.0, vite 8.1.4 → 8.2.1, changesets 2.31.0 → 2.31.1,
  nestjs 11.1.28 → 11.1.29, fastify 5.10.0 → 5.11.3, hono 4.12.29 → 4.13.1,
  inertia 3.5.0 → 3.6.1, vue 3.5.39 → 3.5.41. No major bumps.
- Updated dependencies [[`2fa3de2`](https://github.com/Goopil/clusterkit/commit/2fa3de24ca6de76d2c677f73dddcc3ff6b9e3f85), [`2fa3de2`](https://github.com/Goopil/clusterkit/commit/2fa3de24ca6de76d2c677f73dddcc3ff6b9e3f85), [`2fa3de2`](https://github.com/Goopil/clusterkit/commit/2fa3de24ca6de76d2c677f73dddcc3ff6b9e3f85), [`6060255`](https://github.com/Goopil/clusterkit/commit/6060255be02f1874b32455c5aaca5d4d75ef3258)]:
  - @goopil/clusterkit@1.0.1

## 0.1.0

### Patch Changes

- [#5](https://github.com/Goopil/clusterkit/pull/5) [`a3c1aec`](https://github.com/Goopil/clusterkit/commit/a3c1aec3619c9c90ee1ea7d000f164b40e1c7266) Thanks [@Goopil](https://github.com/Goopil)! - Renovate build tool chain and update packages

- Updated dependencies [[`a3c1aec`](https://github.com/Goopil/clusterkit/commit/a3c1aec3619c9c90ee1ea7d000f164b40e1c7266)]:
  - @goopil/clusterkit@1.0.0
