---
"@goopil/clusterkit-otlp-meter": patch
---

Do not clobber a pre-existing OpenTelemetry global meter provider: when the host app has already registered one, the plugin logs a warning and keeps its own provider for the `clusterkit.*` metrics instead of registering over it.
