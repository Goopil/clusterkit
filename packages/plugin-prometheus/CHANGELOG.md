# @goopil/clusterkit-prometheus

## 1.4.0

### Minor Changes

- [#172](https://github.com/Goopil/clusterkit/pull/172) [`8dfabbb`](https://github.com/Goopil/clusterkit/commit/8dfabbbb079a714ff488f3b49a8abaa42d46424d) Thanks [@Goopil](https://github.com/Goopil)! - fix: no longer collects default process metrics in the primary at count 1 (the forked worker reports them, as in multi-worker mode)

### Patch Changes

- Updated dependencies [[`8dfabbb`](https://github.com/Goopil/clusterkit/commit/8dfabbbb079a714ff488f3b49a8abaa42d46424d)]:
  - @goopil/clusterkit@2.0.0

## 1.3.0

### Minor Changes

- [#170](https://github.com/Goopil/clusterkit/pull/170) [`94ebae6`](https://github.com/Goopil/clusterkit/commit/94ebae6098f9d3e088620dff8d3aa153a1204b71) Thanks [@Goopil](https://github.com/Goopil)! - feat: add `clusterkit_sizing_info{computed_workers,configured_workers}` (scrapeable resolved-vs-configured worker count) and `clusterkit_max_rss_mb` metrics. A ready-to-import Grafana dashboard (fleet slots, sizing plan, recycles, RSS vs limit, event-loop lag, heartbeat age, recovery duration; datasource / multi-select `namespace` / prefix variables) lives in the repository at `packages/plugin-prometheus/grafana/clusterkit-dashboard.json`.

- [#170](https://github.com/Goopil/clusterkit/pull/170) [`94ebae6`](https://github.com/Goopil/clusterkit/commit/94ebae6098f9d3e088620dff8d3aa153a1204b71) Thanks [@Goopil](https://github.com/Goopil)! - feat: primary-side HTTP server helper `serve({ port, host })` — binds in the primary only (no-op in workers), serves `GET /metrics` (merged metrics) and `GET /healthz` (JSON fleet health from `getFleetHealth()`, `503` when degraded), closes on shutdown. Fixes the cluster-mode README example, which bound the server at top level (executed by every worker, racing the primary on the same port with `getMetrics()` throwing in workers).

## 1.2.0

### Minor Changes

- [#166](https://github.com/Goopil/clusterkit/pull/166) [`680276a`](https://github.com/Goopil/clusterkit/commit/680276a9c4f0d4c11ea7807305cffd8f750e355d) Thanks [@Goopil](https://github.com/Goopil)! - feat: worker health, fleet and recovery metrics — per-worker `rss`/`heap`/`eventloop lag`/`heartbeat age` gauges driven by health heartbeats, recycle and wedged-kill counters, live fleet gauges (`active`/`target`/`quarantined` slots) and `recovery_duration_seconds` set on fleet recovery.

## 1.1.3

### Patch Changes

- [#156](https://github.com/Goopil/clusterkit/pull/156) [`0836c02`](https://github.com/Goopil/clusterkit/commit/0836c022510eb686d5a5fa24f2da6a3da3b336a2) Thanks [@Goopil](https://github.com/Goopil)! - Finish the plugin lifecycle in `uninstall()`: the final `active_workers` sync and merged-metrics cache reset now run in
  `uninstall()` instead of a `shutdown:complete` listener (which never fires anymore since `shutdown:complete` is emitted
  after plugin uninstall). **Behavior change for plugin authors:** final work belongs in `uninstall()`, not in a
  `shutdown:complete` listener. Also: uninstalling now removes the collected default process metrics from the registry and
  resets the internal install latch, so reinstalling the plugin (e.g. after a teardown/rebuild cycle) collects default
  metrics again instead of silently skipping them on a fresh registry.

## 1.1.2

### Patch Changes

- [#114](https://github.com/Goopil/clusterkit/pull/114) [`e1991cb`](https://github.com/Goopil/clusterkit/commit/e1991cbce92dd47595afdb7c61f10bba50ce8c9e) Thanks [@Goopil](https://github.com/Goopil)! - Guard `collectDefaultMetrics` against reinstall duplicates (single-worker reinstall with the same registry no longer rejects) and make `getMetrics()` fail fast with an explicit error when called outside the primary process.

## 1.1.1

### Patch Changes

- [#76](https://github.com/Goopil/clusterkit/pull/76) [`405a32c`](https://github.com/Goopil/clusterkit/commit/405a32c6bd38aa9b0e36d510aaef8fb0077df700) Thanks [@Goopil](https://github.com/Goopil)! - Over-engineering cleanup: remove dead methods and flags (`bypassCache`, `memory-first` strategy, `clusterRecommended`), simplify internals. The shutdown non-ACK warn (previously unreachable) now fires with a worker count.

## 1.1.0

### Minor Changes

- [#73](https://github.com/Goopil/clusterkit/pull/73) [`4c8061d`](https://github.com/Goopil/clusterkit/commit/4c8061d4167607ad26cda2f310a0eea03d994180) Thanks [@Goopil](https://github.com/Goopil)! - Relax the `@goopil/clusterkit` peer dependency from an exact version pin to a caret range (`^1.2.0`). Plugins now remain installable with newer core minor releases without requiring a matching plugin upgrade.

### Patch Changes

- [#70](https://github.com/Goopil/clusterkit/pull/70) [`ccca20b`](https://github.com/Goopil/clusterkit/commit/ccca20be1e456e6968bd6bdde709023cf7aefdbc) Thanks [@Goopil](https://github.com/Goopil)! - Document the workers-trusted IPC trust boundary (malformed worker messages can crash the primary via prom-client AggregatorRegistry) and complete the bypassCache guidance.

## 1.0.1

### Patch Changes

- Updated dependencies [[`ce7df52`](https://github.com/Goopil/clusterkit/commit/ce7df522b8a9844f2e5de314e8013b95b12b5c0b)]:
  - @goopil/clusterkit@1.1.1

## 1.0.0

### Patch Changes

- Updated dependencies [[`7c3a622`](https://github.com/Goopil/clusterkit/commit/7c3a6225729f3d2e1a0e569ce363e00326419921)]:
  - @goopil/clusterkit@1.1.0

## 0.1.4

### Patch Changes

- Updated dependencies [[`3094a47`](https://github.com/Goopil/clusterkit/commit/3094a470c5dc3d91592c72ce025caa7092841650)]:
  - @goopil/clusterkit@1.0.4

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
