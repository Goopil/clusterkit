---
"@goopil/clusterkit": patch
---

Cap `overrideWorkerCount()` at 256 workers (MAX_AUTO_WORKERS), consistent with the WEB_CONCURRENCY auto-sizing clamp.
