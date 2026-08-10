---
"@goopil/clusterkit-prometheus": patch
---

Deduplicate concurrent `getMetrics()` calls via an in-flight promise. When the merged metrics cache expires, concurrent scrapes previously each fanned out a separate IPC `clusterMetrics()` round-trip to all workers, risking a cache stampede under concurrent Prometheus scraping. The plugin now tracks an in-flight collection promise and shares it across concurrent non-bypass calls so only one IPC fan-out occurs at a time.
