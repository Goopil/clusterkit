---
"@goopil/clusterkit-otlp-meter": major
---

Remove the redundant `shutdown()` method from `OtlpMeterPlugin`. The meter provider is flushed and closed automatically via the orchestrator's shutdown flow (registered during `install()`); call `plugin.uninstall()` to release it manually.
