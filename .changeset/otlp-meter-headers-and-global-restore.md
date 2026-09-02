---
"@goopil/clusterkit-otlp-meter": minor
---

Add a `headers` option forwarded to the OTLP exporter (e.g. `Authorization` for authenticated collectors), and release the global meter provider registration on `uninstall()` when the plugin set it, so application code no longer resolves meters from a shut-down provider.
