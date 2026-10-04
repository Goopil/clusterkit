# Changelogs

ClusterKit is a pnpm monorepo — each published package carries its own changelog:

| Package                                                | Changelog                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| [`@goopil/clusterkit`](./packages/worker-manager)       | [core orchestrator](./packages/worker-manager/CHANGELOG.md)   |
| [`@goopil/clusterkit-prometheus`](./packages/plugin-prometheus) | [metrics export](./packages/plugin-prometheus/CHANGELOG.md) |
| [`@goopil/clusterkit-sizing`](./packages/plugin-container-sizing) | [container sizing](./packages/plugin-container-sizing/CHANGELOG.md) |
| [`@goopil/clusterkit-otlp-meter`](./packages/plugin-otlp-meter) | [OTLP metrics](./packages/plugin-otlp-meter/CHANGELOG.md) |
| [`@goopil/clusterkit-signal-restart`](./packages/plugin-signal-restart) | [hot restart on signal](./packages/plugin-signal-restart/CHANGELOG.md) |
| [`@goopil/clusterkit-file-watcher`](./packages/plugin-file-watcher) | [hot restart on file/env change](./packages/plugin-file-watcher/CHANGELOG.md) |

Releases are automated with [changesets](https://github.com/changesets/changesets) and published to npm with OIDC
trusted publishing on every merge to `main` — see [RELEASING.md](./RELEASING.md).
