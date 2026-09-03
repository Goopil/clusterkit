---
"@goopil/clusterkit": patch
---

Exit non-zero when the fleet is unrecoverable: the primary now sets `process.exitCode = 1` when the circuit breaker trips or the last worker crashes outside of a graceful shutdown, and clears it back to `0` when full capacity is restored or `resetCircuitBreaker()` succeeds — previously the primary drained with exit code 0, masking a total crash from supervisors and Kubernetes.
