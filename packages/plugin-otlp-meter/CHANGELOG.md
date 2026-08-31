# @goopil/clusterkit-otlp-meter

## 1.1.0

### Minor Changes

- [#70](https://github.com/Goopil/clusterkit/pull/70) [`ccca20b`](https://github.com/Goopil/clusterkit/commit/ccca20be1e456e6968bd6bdde709023cf7aefdbc) Thanks [@Goopil](https://github.com/Goopil)! - Precise missing-module error detection, floor of 1000ms on exportIntervalMs, sync embedded version constant with the package version.

- [#73](https://github.com/Goopil/clusterkit/pull/73) [`4c8061d`](https://github.com/Goopil/clusterkit/commit/4c8061d4167607ad26cda2f310a0eea03d994180) Thanks [@Goopil](https://github.com/Goopil)! - Relax the `@goopil/clusterkit` peer dependency from an exact version pin to a caret range (`^1.2.0`). Plugins now remain installable with newer core minor releases without requiring a matching plugin upgrade.

## 1.0.2

### Patch Changes

- [#56](https://github.com/Goopil/clusterkit/pull/56) [`ce7df52`](https://github.com/Goopil/clusterkit/commit/ce7df522b8a9844f2e5de314e8013b95b12b5c0b) Thanks [@Goopil](https://github.com/Goopil)! - Add `lcov` coverage reporter to align with other packages and enable SonarCloud coverage ingestion.

- Updated dependencies [[`ce7df52`](https://github.com/Goopil/clusterkit/commit/ce7df522b8a9844f2e5de314e8013b95b12b5c0b)]:
  - @goopil/clusterkit@1.1.1

## 1.0.1

### Patch Changes

- [#54](https://github.com/Goopil/clusterkit/pull/54) [`957635c`](https://github.com/Goopil/clusterkit/commit/957635c642121b88ff0c56dff6518d99f5571c31) Thanks [@Goopil](https://github.com/Goopil)! - Add `lcov` coverage reporter to align with other packages and enable SonarCloud coverage ingestion.

## 1.0.0

### Patch Changes

- Updated dependencies [[`7c3a622`](https://github.com/Goopil/clusterkit/commit/7c3a6225729f3d2e1a0e569ce363e00326419921)]:
  - @goopil/clusterkit@1.1.0

## 0.2.0

### Minor Changes

- [#44](https://github.com/Goopil/clusterkit/pull/44) [`93353e3`](https://github.com/Goopil/clusterkit/commit/93353e3ee1629e35dc7f30ff5dcf801242d068b3) Thanks [@Goopil](https://github.com/Goopil)! - Add OpenTelemetry OTLP metrics plugin

### Patch Changes

- Updated dependencies [[`3094a47`](https://github.com/Goopil/clusterkit/commit/3094a470c5dc3d91592c72ce025caa7092841650)]:
  - @goopil/clusterkit@1.0.4
