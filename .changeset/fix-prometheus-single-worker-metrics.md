---
"@goopil/clusterkit-prometheus": patch
---

Fix `active_workers` gauge and default metrics collection in single-worker mode. When the orchestrator runs the app directly in the primary without forking (explicit `workers: 1` or `workers: "auto"` resolving to 1 on a single-CPU machine), no `worker:online` event fires, so the gauge stayed at 0 and default process metrics were never collected. The plugin now uses the resolved `orchestrator.workerCount` (not the unresolved config value) to detect single-worker mode and seeds the gauge to 1 + collects default metrics in the primary.
