# `@goopil/clusterkit-otlp-meter`

OpenTelemetry OTLP metrics plugin for `@goopil/clusterkit`.

This package exports orchestration metrics and per-worker host metrics via OTLP
(OpenTelemetry Protocol) to a collector. It supports both OTLP/HTTP and OTLP/gRPC
transports.

## Capabilities

| Capability                    | Details                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Orchestration metrics         | Tracks active workers, restarts, crashes, and circuit-breaker trips from orchestrator events     |
| Host/process metrics          | Optional Node.js process metrics (CPU, memory, GC, event loop) via `@opentelemetry/host-metrics` |
| OTLP/HTTP export              | Push metrics to an OTLP/HTTP collector endpoint (default)                                        |
| OTLP/gRPC export              | Push metrics to an OTLP/gRPC collector endpoint (optional)                                       |
| Primary/worker-aware behavior | Event listeners only on primary, host metrics on workers (or primary in single-worker mode)      |

## Installation

```bash
pnpm add @goopil/clusterkit-otlp-meter @opentelemetry/api @opentelemetry/sdk-metrics @opentelemetry/resources @opentelemetry/semantic-conventions @opentelemetry/exporter-metrics-otlp-http
```

For gRPC transport, also install:

```bash
pnpm add @opentelemetry/exporter-metrics-otlp-grpc
```

For host/process metrics, also install:

```bash
pnpm add @opentelemetry/host-metrics
```

## Usage

```ts
import { Orchestrator } from "@goopil/clusterkit";
import { createOtlpMeterPlugin } from "@goopil/clusterkit-otlp-meter";

const orchestrator = new Orchestrator({ logger: console });

const otlp = createOtlpMeterPlugin({
  endpoint: "http://otel-collector:4318/v1/metrics",
  protocol: "http",
  serviceName: "my-app",
  instrumentation: true,
  exportIntervalMs: 30_000,
  attributes: { environment: "production" },
});

orchestrator.use(otlp).run(async () => {
  // your app bootstrap
});
```

## Options (`OtlpMeterPluginOptions`)

| Option             | Type                                          | Default                                                              | Description                                 |
| ------------------ | --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| `endpoint`         | `string`                                      | `http://localhost:4318/v1/metrics` (HTTP) or `localhost:4317` (gRPC) | OTLP collector endpoint URL                 |
| `protocol`         | `'http' \| 'grpc'`                            | `'http'`                                                             | OTLP transport protocol                     |
| `instrumentation`  | `boolean`                                     | `true`                                                               | Collect Node.js host/process metrics        |
| `prefix`           | `string`                                      | `'clusterkit.'`                                                      | Metric name prefix                          |
| `attributes`       | `Record<string, string \| number \| boolean>` | `{}`                                                                 | Static resource attributes                  |
| `exportIntervalMs` | `number`                                      | `60000`                                                              | Export interval in milliseconds             |
| `serviceName`      | `string`                                      | `'clusterkit'`                                                       | Service name for the OpenTelemetry Resource |

## API (`OtlpMeterPlugin`)

```ts
otlp.meterProvider; // MeterProvider | undefined
await otlp.shutdown(); // flush and close
```

## Custom metrics

The plugin registers its `MeterProvider` as the OpenTelemetry global, so you can create
custom metrics from anywhere in your application without a reference to the plugin instance:

```ts
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("my-app");
const httpRequests = meter.createCounter("http.requests", {
  description: "Total HTTP requests",
});

httpRequests.add(1);
```

This works in both primary and worker processes — each process has its own provider
pushing to the same collector endpoint.

## Metrics exposed

With the default prefix (`clusterkit.`):

- `clusterkit.active_workers` (ObservableGauge)
- `clusterkit.worker.restarts` (Counter)
- `clusterkit.worker.crashes` (Counter)
- `clusterkit.circuit_breaker.trips` (Counter)

Plus Node.js host/process metrics from `@opentelemetry/host-metrics` when `instrumentation: true`.

In single-worker mode (`workers: 1`), the orchestrator runs the app directly in the
primary process without forking. The plugin collects host metrics on the primary since
there are no worker processes to collect from.

## Security / exposure notes

- This plugin does not open listening sockets — it pushes to a collector endpoint.
- Your collector endpoint should be on a private network or behind access controls.
- Treat metrics as operationally sensitive because they can expose process, topology,
  runtime, and workload details.

## Related docs

- [Root README](../../README.md)
- [Core package README](../worker-manager/README.md)
- [Prometheus plugin README](../plugin-prometheus/README.md)
