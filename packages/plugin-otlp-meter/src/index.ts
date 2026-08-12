import cluster from "node:cluster";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { type Logger, type Orchestrator, type ResolvedConfig, withLoggerPrefix } from "@goopil/clusterkit";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { ATTR_HOST_NAME, ATTR_PROCESS_PID } from "@opentelemetry/semantic-conventions/incubating";
import type { OtlpMeterPlugin, OtlpMeterPluginOptions } from "./types.js";

export type { OtlpMeterPlugin, OtlpMeterPluginOptions } from "./types.js";

type PrimaryEvent = "worker:crash" | "worker:restart" | "circuit-breaker:tripped";

const DEFAULT_HTTP_ENDPOINT = "http://localhost:4318/v1/metrics";
const DEFAULT_GRPC_ENDPOINT = "localhost:4317";

export function createOtlpMeterPlugin(options: OtlpMeterPluginOptions = {}): OtlpMeterPlugin {
  const {
    protocol = "http",
    instrumentation = true,
    prefix = "clusterkit.",
    attributes = {},
    exportIntervalMs = 60_000,
    serviceName = "clusterkit",
    endpoint,
  } = options;

  if (!Number.isFinite(exportIntervalMs) || exportIntervalMs <= 0) {
    throw new TypeError("otlp-meter plugin: exportIntervalMs must be a finite number > 0");
  }

  const resolvedEndpoint = endpoint ?? (protocol === "grpc" ? DEFAULT_GRPC_ENDPOINT : DEFAULT_HTTP_ENDPOINT);

  let meterProvider: MeterProvider | undefined;
  let pluginLog: Logger | null = null;
  let primaryOrchestrator: Orchestrator | undefined;
  const primaryListeners: Array<{ event: PrimaryEvent; listener: () => void }> = [];

  const clearPrimaryListeners = (): void => {
    if (!primaryOrchestrator) return;
    for (const { event, listener } of primaryListeners) {
      primaryOrchestrator.off(event, listener);
    }
    primaryListeners.length = 0;
    primaryOrchestrator = undefined;
  };

  async function createExporter(): Promise<unknown> {
    if (protocol === "grpc") {
      try {
        const mod = await import("@opentelemetry/exporter-metrics-otlp-grpc");
        return new mod.OTLPMetricExporter({ url: resolvedEndpoint });
      } catch {
        throw new Error(
          "otlp-meter plugin: protocol 'grpc' requires @opentelemetry/exporter-metrics-otlp-grpc — install it or use protocol 'http'",
        );
      }
    }
    try {
      const mod = await import("@opentelemetry/exporter-metrics-otlp-http");
      return new mod.OTLPMetricExporter({ url: resolvedEndpoint });
    } catch {
      throw new Error(
        "otlp-meter plugin: protocol 'http' requires @opentelemetry/exporter-metrics-otlp-http — install it or use protocol 'grpc'",
      );
    }
  }

  async function startHostMetrics(): Promise<void> {
    try {
      const mod = await import("@opentelemetry/host-metrics");
      const hostMetrics = new mod.HostMetrics({ meterProvider: meterProvider });
      hostMetrics.start();
    } catch {
      pluginLog?.warn("host-metrics package not installed — skipping process metrics");
    }
  }

  return {
    name: "otlp-meter",

    get meterProvider() {
      return meterProvider;
    },

    async install(orchestrator: Orchestrator, logger: Logger | null, _config: ResolvedConfig): Promise<void> {
      const log = withLoggerPrefix(logger, "clusterkit:otlp-meter");
      pluginLog = log;

      const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_INSTANCE_ID]: randomUUID(),
        [ATTR_HOST_NAME]: os.hostname(),
        [ATTR_PROCESS_PID]: process.pid,
        ...attributes,
      });

      const exporter = await createExporter();

      const metricReader = new PeriodicExportingMetricReader({
        exporter: exporter as PushMetricExporter,
        exportIntervalMillis: exportIntervalMs,
      });

      meterProvider = new MeterProvider({
        resource,
        readers: [metricReader],
      });

      const meter = meterProvider.getMeter("@goopil/clusterkit", "0.1.0");

      if (cluster.isPrimary) {
        log?.debug("Plugin installed on primary process");
        primaryOrchestrator = orchestrator;

        const activeWorkersGauge = meter.createObservableGauge(`${prefix}active_workers`, {
          description: "Number of active cluster workers",
        });
        activeWorkersGauge.addCallback((result) => {
          result.observe(orchestrator.getMetrics().activeWorkers);
        });

        const workerRestartsCounter = meter.createCounter(`${prefix}worker.restarts`, {
          description: "Total number of worker restarts",
        });
        const workerCrashesCounter = meter.createCounter(`${prefix}worker.crashes`, {
          description: "Total number of worker crashes",
        });
        const circuitBreakerTripsCounter = meter.createCounter(`${prefix}circuit_breaker.trips`, {
          description: "Total number of circuit breaker trips",
        });

        const bind = (event: PrimaryEvent, listener: () => void): void => {
          orchestrator.on(event, listener);
          primaryListeners.push({ event, listener });
        };

        bind("worker:crash", () => {
          workerCrashesCounter.add(1);
        });
        bind("worker:restart", () => {
          workerRestartsCounter.add(1);
        });
        bind("circuit-breaker:tripped", () => {
          circuitBreakerTripsCounter.add(1);
        });

        const singleWorker = orchestrator.workerCount === 1;
        if (singleWorker && instrumentation) {
          await startHostMetrics();
        }
      } else {
        log?.debug("Plugin installed on worker process");

        if (instrumentation) {
          await startHostMetrics();
        }
      }

      orchestrator.registerOnShutdown(async () => {
        await meterProvider?.shutdown();
      });
    },

    async uninstall(): Promise<void> {
      clearPrimaryListeners();
    },

    async shutdown(): Promise<void> {
      await meterProvider?.shutdown();
      meterProvider = undefined;
    },
  };
}
