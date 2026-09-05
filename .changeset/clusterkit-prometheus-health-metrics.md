---
"@goopil/clusterkit-prometheus": minor
---

feat: worker health, fleet and recovery metrics — per-worker `rss`/`heap`/`eventloop lag`/`heartbeat age` gauges driven by health heartbeats, recycle and wedged-kill counters, live fleet gauges (`active`/`target`/`quarantined` slots) and `recovery_duration_seconds` set on fleet recovery.
