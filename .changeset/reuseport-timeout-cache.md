---
"@goopil/clusterkit": patch
---

The SO_REUSEPORT two-socket probe no longer caches a timeout as "unsupported": a timeout is inconclusive, so the next call re-probes instead of permanently losing reusePort after a CPU-starved boot.
