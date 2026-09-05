---
"@goopil/clusterkit": minor
---

feat: worker health & recovery subsystem — opt-in worker health heartbeats (`health.heartbeatMs`) emitting `worker:health` reports, RSS-based recycling (`workers.maxRssMb`) and wedged-worker detection (`health.wedgedTimeoutMs`) through the shared bounded drain, fleet health surface (`getFleetHealth()`, `fleet:degraded`/`fleet:recovered` via `health.degradedAfterMs`), and boot-loop quarantine (`restart.bootFailQuarantine`) with `restartWorkers()` as the remedy.
