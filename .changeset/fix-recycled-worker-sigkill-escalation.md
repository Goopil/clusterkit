---
"@goopil/clusterkit": patch
---

Fix leaked recycled workers by escalating to SIGTERM after 5s and SIGKILL after 2s more, replacing the no-op `disconnect()` retry that left stuck workers alive indefinitely.
