# @goopil/clusterkit

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
