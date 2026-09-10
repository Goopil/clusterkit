---
"@goopil/clusterkit": patch
---

Self-heal a total fleet loss: when every worker dies at once, the primary now holds its event loop while the
restart queue re-forks replacements through the normal backoff (exit code 1 stays set until capacity is restored,
then clears). Previously the unref'd restart timers let the primary drain and exit with code 1 before the first
replacement could fork. The primary still drains and exits with the failure code when no more forks are coming —
a circuit-breaker trip or an unrecoverable fork environment — and a graceful shutdown is never delayed (the hold
is released when shutdown starts). A `beforeExit` log line now makes a failure-exit drain explicit in the logs.
