---
"@goopil/clusterkit": patch
---

Core hygiene fixes from audit issue #97: `use()` now throws when called after `run()` (plugins must be registered before the orchestrator starts — previously silently ignored); an invalid `WEB_CONCURRENCY` value now logs a warning through the configured logger before falling back to the CPU count; a crash-loop circuit-breaker trip emits a `process.emitWarning` (`ClusterKitCrashLoop`) so setups without a logger are not fully silent; `HealthStatus.live` is documented as always true by design (readiness is the signal, not liveness).
