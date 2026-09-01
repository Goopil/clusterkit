---
"@goopil/clusterkit-file-watcher": patch
---

Fix single-worker detection: use the resolved `orchestrator.workerCount` instead of the raw config so `workers: 'auto'` on a 1-CPU host correctly takes the single-worker path.
