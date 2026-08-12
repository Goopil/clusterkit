---
"@goopil/clusterkit": patch
---

Fix uncaught EPIPE error during worker shutdown when a worker exits while the primary is sending the shutdown message or disconnecting the IPC channel.
