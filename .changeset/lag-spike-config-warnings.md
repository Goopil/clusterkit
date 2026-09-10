---
"@goopil/clusterkit": patch
---

Add `health.lagSpikeMs`: recycle a worker on a single heartbeat whose event-loop lag exceeds the
threshold — catches one-off long sync blocks that the sustained-lag policy (`maxEventLoopLagMs`
+ `lagRecycleBeats`) never sees. Opt-in, default `0` (disabled), requires `health.heartbeatMs > 0`.

Unknown keys inside a config section (`workers`, `restart`, `shutdown`, `health`) now emit a
`ClusterKitConfigWarning` instead of being silently ignored, with a "did you mean" suggestion when
the key exists in another section (e.g. `health.maxRssMb` → `workers.maxRssMb`).
