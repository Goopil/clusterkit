---
"@goopil/clusterkit": patch
---

Register SIGTERM/SIGINT/SIGHUP handlers before forking workers so a signal received during the boot window triggers a graceful shutdown instead of orphaning the fleet.
