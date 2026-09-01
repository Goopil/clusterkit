---
"@goopil/clusterkit": patch
---

Extend the `workers.execArgv` blocklist to reject side-effect flags that previously passed validation: `--tls-keylog`, `--cpu-prof`/`--heap-prof` (and their variants), `--report-*`, `--diagnostic-dir`, and `--redirect-warnings`, which could silently write profiling data or leak TLS session keys from every worker.
