---
"@goopil/clusterkit-signal-restart": minor
---

Initial release: signal-based hot restart plugin. Listens for SIGHUP (or custom signal) and triggers `Orchestrator.restartWorkers()` for rolling worker restarts without dropping connections.
