---
"@goopil/clusterkit-otlp-meter": patch
---
Flush the OTLP exporter when the plugin is uninstalled (idempotent via the existing shutdown latch).
