---
"@goopil/clusterkit-signal-restart": patch
---

Warn at install when the configured restart signal is shutdown-reserved (SIGTERM/SIGINT) or when SIGHUP is used on a TTY (terminal hangup triggers fleet restart).
