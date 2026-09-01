---
"@goopil/clusterkit-otlp-meter": patch
---
Reset the shutdown latch on reinstall so a plugin instance can be reinstalled: the previous provider is shut down first and the new one can flush.
