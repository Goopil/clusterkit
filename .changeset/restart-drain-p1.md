---
"@goopil/clusterkit": patch
---

Derive recycle drain escalation delays (SIGTERM/SIGKILL) from the shutdown config instead of hardcoded 5s/2s, suppress the misleading `restart:complete` event when a rolling restart is aborted by shutdown, and prevent an async EPIPE from a dying worker's IPC channel from crashing the primary during drain.
