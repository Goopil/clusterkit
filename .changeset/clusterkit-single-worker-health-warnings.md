---
"@goopil/clusterkit": minor
---

feat: warn at startup when health policies are configured but disabled by single-worker mode — `workers.maxRssMb`, `health.wedgedTimeoutMs` and `health.degradedAfterMs` are fed by worker heartbeats over IPC and never evaluate when the app runs in the primary without forking (`workers.count: 1`, including `count: 'auto'` resolving to 1 CPU).
