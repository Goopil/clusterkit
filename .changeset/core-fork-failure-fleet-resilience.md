---
"@goopil/clusterkit": patch
---

Fix fork failures permanently shrinking the fleet and restart queue leaks. A throwing `forkWorker()` (EMFILE/ENOMEM)
now re-queues the restart (retried through the normal backoff) instead of losing it, and after 3 consecutive fork
failures the environment is declared unrecoverable (`process.exitCode = 1`) instead of retrying forever. The
crash-restart queue drops queued entries once the circuit breaker is tripped (no fork leaks past a trip), and
`resetCircuitBreaker()` refills capacity with a proper "refilling capacity" log instead of a fake crash report for a
never-crashed worker 0. `restartWorkers()` now skips workers that died mid-roll (previously leaving a stale
recycling mark that skewed crash-restart capacity math, and stalling the roll for the full drain budget), leaves the
old worker running when a roll fork fails, and freshly forked workers carry an `'error'` listener so async fork
errors cannot crash the primary as an uncaught exception.
