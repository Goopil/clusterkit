---
"@goopil/clusterkit-otlp-meter": minor
---

Add a `headers` option forwarded to the OTLP/HTTP exporter (e.g. `Authorization` for authenticated collectors). Headers apply to `protocol: 'http'` only — with `protocol: 'grpc'` the gRPC exporter does not support them, so they are ignored and a warning is logged (configure exporter `metadata` or switch to HTTP). Also release the global meter provider registration on `uninstall()` when the plugin set it, so application code no longer resolves meters from a shut-down provider.
