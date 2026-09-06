---
"@goopil/clusterkit-prometheus": minor
---

feat: add `clusterkit_sizing_info{computed_workers,configured_workers}` (scrapeable resolved-vs-configured worker count) and `clusterkit_max_rss_mb` metrics. A ready-to-import Grafana dashboard (fleet slots, sizing plan, recycles, RSS vs limit, event-loop lag, heartbeat age, recovery duration; datasource / multi-select `namespace` / prefix variables) lives in the repository at `packages/plugin-prometheus/grafana/clusterkit-dashboard.json`.
