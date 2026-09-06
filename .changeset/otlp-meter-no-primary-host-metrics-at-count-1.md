---
"@goopil/clusterkit-otlp-meter": minor
---

fix: no longer collects host metrics in the primary at count 1 — system metrics were double-counted once count 1 forked (requires clusterkit 2.0)
