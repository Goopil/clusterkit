---
"@goopil/clusterkit": patch
---
Run `registerOnShutdown` callbacks during multi-worker primary shutdown and unref the restart backoff timer, so plugin flushes and cleanups are no longer silently skipped on deploy.
