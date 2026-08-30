# @goopil/clusterkit-file-watcher

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
