import cluster from "node:cluster";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { type Logger, type Orchestrator, type ResolvedConfig, withLoggerPrefix } from "@goopil/clusterkit";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { OtlpMeterPlugin, OtlpMeterPluginOptions } from "./types.js";

export type { OtlpMeterPlugin, OtlpMeterPluginOptions } from "./types.js";

type PrimaryEvent = "worker:crash" | "worker:restart" | "circuit-breaker:tripped";

const DEFAULT_HTTP_ENDPOINT = "http://localhost:4318/v1/metrics";
const DEFAULT_GRPC_ENDPOINT = "localhost:4317";

const ATTR_HOST_NAME = "host.name";
const ATTR_PROCESS_PID = "process.pid";

const PLUGIN_VERSION = "0.1.0";

function isMissingModuleError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("Cannot find package") ||
    msg.includes("MODULE_NOT_FOUND") ||
    msg.includes("is not a constructor") ||
    msg.includes("export is defined on the") ||
    msg.includes("is not defined on the") ||
    "code" in err
  );
}

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

  if (protocol === "http") {
    try {
      new URL(resolvedEndpoint);
    } catch {
      throw new TypeError(`otlp-meter plugin: invalid endpoint URL "${resolvedEndpoint}"`);
    }
  }

  let meterProvider: MeterProvider | undefined;
  let isShutdown = false;
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

  async function createExporter(): Promise<PushMetricExporter> {
    const exporterModuleName =
      protocol === "grpc" ? "@opentelemetry/exporter-metrics-otlp-grpc" : "@opentelemetry/exporter-metrics-otlp-http";

    try {
      const mod = await import(exporterModuleName);
      return new mod.OTLPMetricExporter({ url: resolvedEndpoint }) as PushMetricExporter;
    } catch (err) {
      if (isMissingModuleError(err)) {
        throw new Error(
          `otlp-meter plugin: protocol '${protocol}' requires ${exporterModuleName} — install it or use protocol '${protocol === "grpc" ? "http" : "grpc"}'`,
        );
      }
      throw err;
    }
  }

  async function startHostMetrics(provider: MeterProvider): Promise<void> {
    try {
      const mod = await import("@opentelemetry/host-metrics");
      const hostMetrics = new mod.HostMetrics({ meterProvider: provider });
      hostMetrics.start();
    } catch (err) {
      if (isMissingModuleError(err)) {
        pluginLog?.warn("host-metrics package not installed — skipping process metrics");
      } else {
        throw err;
      }
    }
  }

  async function shutdownProvider(): Promise<void> {
    if (isShutdown || !meterProvider) return;
    isShutdown = true;
    await meterProvider.shutdown();
    meterProvider = undefined;
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
        exporter,
        exportIntervalMillis: exportIntervalMs,
      });

      meterProvider = new MeterProvider({
        resource,
        readers: [metricReader],
      });

      const meter = meterProvider.getMeter("@goopil/clusterkit", PLUGIN_VERSION);

      if (cluster.isPrimary) {
        clearPrimaryListeners();
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
          await startHostMetrics(meterProvider);
        }
      } else {
        log?.debug("Plugin installed on worker process");

        if (instrumentation) {
          await startHostMetrics(meterProvider);
        }
      }

      orchestrator.registerOnShutdown(async () => {
        await shutdownProvider();
      });
    },

    async uninstall(): Promise<void> {
      clearPrimaryListeners();
    },

    async shutdown(): Promise<void> {
      await shutdownProvider();
    },
  };
}
