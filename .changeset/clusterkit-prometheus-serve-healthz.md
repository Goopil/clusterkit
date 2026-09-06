---
"@goopil/clusterkit-prometheus": minor
---

feat: primary-side HTTP server helper `serve({ port, host })` — binds in the primary only (no-op in workers), serves `GET /metrics` (merged metrics) and `GET /healthz` (JSON fleet health from `getFleetHealth()`, `503` when degraded), closes on shutdown. Fixes the cluster-mode README example, which bound the server at top level (executed by every worker, racing the primary on the same port with `getMetrics()` throwing in workers).
