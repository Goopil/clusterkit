import type { OrchestratorPlugin } from "@goopil/clusterkit";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";

export interface OtlpMeterPluginOptions {
  /**
   * OTLP collector endpoint URL.
   * For 'http' protocol: defaults to 'http://localhost:4318/v1/metrics'
   * For 'grpc' protocol: defaults to 'localhost:4317'
   * If you pass a full URL, it overrides the default for the selected protocol.
   */
  endpoint?: string;

  /**
   * Custom headers attached to every OTLP export request
   * (e.g. `Authorization` for authenticated collectors).
   * Applies to `protocol: 'http'` only — with `'grpc'` the gRPC exporter
   * does not support headers; they are ignored and a warning is logged.
   * Configure metadata on the exporter directly instead.
   */
  headers?: Record<string, string>;

  /** OTLP transport protocol. @default 'http' */
  protocol?: "http" | "grpc";

  /** Collect Node.js host/process metrics (CPU, memory, GC, event loop). @default true */
  instrumentation?: boolean;

  /** Metric name prefix. @default 'clusterkit.' */
  prefix?: string;

  /** Static resource attributes added to the OpenTelemetry Resource. @default {} */
  attributes?: Record<string, string | number | boolean>;

  /** Export interval in milliseconds (how often metrics push to the collector). Minimum 1000. @default 60000 */
  exportIntervalMs?: number;

  /** Service name for the OpenTelemetry Resource. @default 'clusterkit' */
  serviceName?: string;
}

export interface OtlpMeterPlugin extends OrchestratorPlugin {
  /**
   * The OpenTelemetry MeterProvider (created in primary and worker processes;
   * undefined before install).
   */
  readonly meterProvider: MeterProvider | undefined;

  /**
   * Gracefully shut down the provider and flush pending exports.
   * Also registered via orchestrator.registerOnShutdown() during install.
   */
  shutdown(): Promise<void>;
}
