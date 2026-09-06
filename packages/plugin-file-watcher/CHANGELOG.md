# @goopil/clusterkit-file-watcher

## 1.2.0

### Minor Changes

- [#172](https://github.com/Goopil/clusterkit/pull/172) [`8dfabbb`](https://github.com/Goopil/clusterkit/commit/8dfabbbb079a714ff488f3b49a8abaa42d46424d) Thanks [@Goopil](https://github.com/Goopil)! - feat: file/env watching is now effective at workers.count 1 (requires clusterkit 2.0)

### Patch Changes

- Updated dependencies [[`8dfabbb`](https://github.com/Goopil/clusterkit/commit/8dfabbbb079a714ff488f3b49a8abaa42d46424d)]:
  - @goopil/clusterkit@2.0.0

## 1.1.4

### Patch Changes

- [#152](https://github.com/Goopil/clusterkit/pull/152) [`b0cec25`](https://github.com/Goopil/clusterkit/commit/b0cec25ef94753990f7e42d68d68eeb956db9f29) Thanks [@Goopil](https://github.com/Goopil)! - Fix plugin reinstall after uninstall/shutdown (watchers now re-arm instead of staying dead), ignore `node_modules` directories by default to prevent restart storms on package installs (`watchOptions.ignored` overrides entirely, `ignore` patterns merge with the default), and widen the chokidar peer range to `^4.0.0 || ^5.0.0`.

## 1.1.3

### Patch Changes

- [#127](https://github.com/Goopil/clusterkit/pull/127) [`a516e35`](https://github.com/Goopil/clusterkit/commit/a516e35581d6bd9714973a8b934b27cc2c996c73) Thanks [@Goopil](https://github.com/Goopil)! - Harden `parseEnvFile`: strip inline comments (` # ...`) from unquoted values while preserving them inside quotes, and skip prototype-pollution keys (`__proto__`, `constructor`, `prototype`) instead of setting them on the parsed object.

## 1.1.2

### Patch Changes

- [#115](https://github.com/Goopil/clusterkit/pull/115) [`88d1969`](https://github.com/Goopil/clusterkit/commit/88d19699d17512be2979f8e925943ac3517e6f9f) Thanks [@Goopil](https://github.com/Goopil)! - Cancel the pending `startDelayMs` timer on uninstall/shutdown, guard `startWatchers` against a post-cleanup start, and preserve (merge, not overwrite) the `.env` payload through debounce coalescing with a trailing flush after `minRestartIntervalMs` skips.

## 1.1.1

### Patch Changes

- [#106](https://github.com/Goopil/clusterkit/pull/106) [`383a617`](https://github.com/Goopil/clusterkit/commit/383a617f15bbb64fd3a40f6e717dd2d9914fbce2) Thanks [@Goopil](https://github.com/Goopil)! - Fix single-worker detection: use the resolved `orchestrator.workerCount` instead of the raw config so `workers: 'auto'` on a 1-CPU host correctly takes the single-worker path.

## 1.1.0

### Minor Changes

- [#70](https://github.com/Goopil/clusterkit/pull/70) [`ccca20b`](https://github.com/Goopil/clusterkit/commit/ccca20be1e456e6968bd6bdde709023cf7aefdbc) Thanks [@Goopil](https://github.com/Goopil)! - Add `debounceMaxWaitMs` (fire during continuous change storms) and `minRestartIntervalMs` (throttle back-to-back restarts), both defaulting to off. Correct docs: chokidar v4 paths are literal (no globs); document the watch-directory write-back footgun.

- [#73](https://github.com/Goopil/clusterkit/pull/73) [`4c8061d`](https://github.com/Goopil/clusterkit/commit/4c8061d4167607ad26cda2f310a0eea03d994180) Thanks [@Goopil](https://github.com/Goopil)! - Relax the `@goopil/clusterkit` peer dependency from an exact version pin to a caret range (`^1.2.0`). Plugins now remain installable with newer core minor releases without requiring a matching plugin upgrade.

## 1.0.1

### Patch Changes

- [#56](https://github.com/Goopil/clusterkit/pull/56) [`ce7df52`](https://github.com/Goopil/clusterkit/commit/ce7df522b8a9844f2e5de314e8013b95b12b5c0b) Thanks [@Goopil](https://github.com/Goopil)! - Fix all 32 open SonarCloud issues: refactor validateConfig to reduce cognitive complexity, fix async signal handler, extract nested ternaries, use Set for dangerous keys, log caught exceptions in platform detection, parameterize duplicate tests, add missing test assertions, and prefer toHaveLength over toBe for array lengths.

- Updated dependencies [[`ce7df52`](https://github.com/Goopil/clusterkit/commit/ce7df522b8a9844f2e5de314e8013b95b12b5c0b)]:
  - @goopil/clusterkit@1.1.1

## 1.0.0

### Minor Changes

- [#50](https://github.com/Goopil/clusterkit/pull/50) [`7c3a622`](https://github.com/Goopil/clusterkit/commit/7c3a6225729f3d2e1a0e569ce363e00326419921) Thanks [@Goopil](https://github.com/Goopil)! - Initial release: file watcher hot restart plugin. Watches source files, `.env` files, and `process.env` for changes. Supports debounced rolling restarts, `dryRun` mode, and custom env parsers.

### Patch Changes

- Updated dependencies [[`7c3a622`](https://github.com/Goopil/clusterkit/commit/7c3a6225729f3d2e1a0e569ce363e00326419921)]:
  - @goopil/clusterkit@1.1.0
