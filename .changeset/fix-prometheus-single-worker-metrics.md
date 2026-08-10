---
"@goopil/clusterkit-prometheus": patch
---

Fix `active_workers` gauge and default metrics collection in single-worker mode (`workers: 1`). When the orchestrator runs the app directly in the primary without forking, no `worker:online` event fires, so the gauge stayed at 0 and default process metrics were never collected. The plugin now seeds the gauge to 1 and collects default metrics in the primary when `workers.count === 1`.
