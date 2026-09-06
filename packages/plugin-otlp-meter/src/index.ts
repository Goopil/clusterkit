import cluster from "node:cluster";
import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  type Logger,
  type Orchestrator,
  type OrchestratorEvents,
  type ResolvedConfig,
  withLoggerPrefix,
} from "@goopil/clusterkit";
import { metrics, type ObservableResult } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import pkgJson from "../package.json" with { type: "json" };
import type { OtlpMeterPlugin, OtlpMeterPluginOptions } from "./types.js";

export type { OtlpMeterPlugin, OtlpMeterPluginOptions } from "./types.js";

type PrimaryEvent =
  | "worker:crash"
  | "worker:restart"
  | "circuit-breaker:tripped"
  | "worker:health"
  | "worker:exit"
  | "worker:recycle"
  | "worker:wedged"
  | "fleet:recovered";

const DEFAULT_HTTP_ENDPOINT = "http://localhost:4318/v1/metrics";
const DEFAULT_GRPC_ENDPOINT = "localhost:4317";

const ATTR_HOST_NAME = "host.name";
const ATTR_PROCESS_PID = "process.pid";

const PLUGIN_VERSION: string = pkgJson.version;

function isMissingModuleError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
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
    headers,
  } = options;

  if (!Number.isFinite(exportIntervalMs) || exportIntervalMs < 1_000) {
    throw new TypeError(
      "otlp-meter plugin: exportIntervalMs must be a finite number >= 1000 (minimum 1s to avoid flooding the collector)",
    );
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
  let pluginSetGlobalProvider = false;
  let pluginLog: Logger | null = null;
  let primaryOrchestrator: Orchestrator | undefined;
  interface WorkerHealthSample {
    pid: number;
    rss: number;
    heapUsed: number;
    eventLoopLagMs: number;
    lastBeatAt: number;
  }

  // Listeners stored payload-agnostic; the concrete payload type is inferred at
  // the bind() call site via OrchestratorEvents[E].
  const primaryListeners: Array<{ event: PrimaryEvent; listener: (...args: never[]) => void }> = [];
  const workerHealth = new Map<number, WorkerHealthSample>();

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

    // The gRPC exporter config omits `headers` (gRPC uses `metadata` instead):
    // forwarding them would be silently dropped, leaving exports unauthenticated.
    if (protocol === "grpc" && headers && Object.keys(headers).length > 0) {
      pluginLog?.warn(
        "headers are not supported by the gRPC exporter — configure metadata via the exporter's own options or use protocol: 'http'",
      );
    }

    try {
      const mod = await import(exporterModuleName);
      const config = protocol === "grpc" ? { url: resolvedEndpoint } : { url: resolvedEndpoint, headers };
      return new mod.OTLPMetricExporter(config) as PushMetricExporter;
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

      // Reinstalling the same instance after a shutdown must not orphan the old
      // provider or leave the latch stuck at `true` (the new provider's shutdown
      // would otherwise be a permanent no-op).
      if (meterProvider) await shutdownProvider();
      isShutdown = false;

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

      // setGlobalMeterProvider() refuses to override an existing registration
      // and returns false — never clobber the app's own OTel setup.
      if (metrics.setGlobalMeterProvider(meterProvider)) {
        pluginSetGlobalProvider = true;
      } else {
        log?.warn(
          "A global OpenTelemetry meter provider is already registered — leaving it untouched; clusterkit meters use the plugin's own provider",
        );
      }

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

        const workerRssGauge = meter.createObservableGauge(`${prefix}worker.rss_bytes`, {
          description: "Resident set size per worker from health heartbeats",
          unit: "By",
        });
        const workerHeapGauge = meter.createObservableGauge(`${prefix}worker.heap_used_bytes`, {
          description: "V8 heap used per worker from health heartbeats",
          unit: "By",
        });
        const workerLagGauge = meter.createObservableGauge(`${prefix}worker.eventloop_lag_ms`, {
          description: "Event loop lag per worker from health heartbeats",
          unit: "ms",
        });
        const workerHeartbeatAgeGauge = meter.createObservableGauge(`${prefix}worker.heartbeat_age_seconds`, {
          description: "Seconds since the last health heartbeat per worker",
          unit: "s",
        });

        const observeWorkerHealth = (
          result: ObservableResult<number>,
          pick: (sample: WorkerHealthSample) => number,
        ): void => {
          for (const [workerId, sample] of workerHealth) {
            result.observe(pick(sample), { "worker.id": workerId, "process.pid": sample.pid });
          }
        };

        workerRssGauge.addCallback((result) => observeWorkerHealth(result, (s) => s.rss));
        workerHeapGauge.addCallback((result) => observeWorkerHealth(result, (s) => s.heapUsed));
        workerLagGauge.addCallback((result) => observeWorkerHealth(result, (s) => s.eventLoopLagMs));
        workerHeartbeatAgeGauge.addCallback((result) => {
          const now = Date.now();
          observeWorkerHealth(result, (s) => Math.max(0, (now - s.lastBeatAt) / 1000));
        });

        const workerRecyclesCounter = meter.createCounter(`${prefix}worker.recycles`, {
          description: "Total number of worker recycles by reason",
        });
        const wedgedKillsCounter = meter.createCounter(`${prefix}worker.wedged.kills`, {
          description: "Total number of workers killed for being unresponsive",
        });
        const recoveryDurationGauge = meter.createGauge(`${prefix}recovery.duration_seconds`, {
          description: "Duration of the last fleet degraded-to-recovered cycle",
          unit: "s",
        });

        const fleetTargetGauge = meter.createObservableGauge(`${prefix}fleet.target_workers`, {
          description: "Target worker count (live fleet health)",
        });
        const fleetActiveGauge = meter.createObservableGauge(`${prefix}fleet.active_workers`, {
          description: "Currently active workers (live fleet health)",
        });
        const fleetQuarantinedGauge = meter.createObservableGauge(`${prefix}fleet.quarantined_slots`, {
          description: "Quarantined worker slots (live fleet health)",
        });

        fleetTargetGauge.addCallback((result) => {
          result.observe(orchestrator.getFleetHealth().target);
        });
        fleetActiveGauge.addCallback((result) => {
          result.observe(orchestrator.getFleetHealth().active);
        });
        fleetQuarantinedGauge.addCallback((result) => {
          result.observe(orchestrator.getFleetHealth().quarantined);
        });

        const bind = <E extends PrimaryEvent>(event: E, listener: (...args: OrchestratorEvents[E]) => void): void => {
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

        bind("worker:health", ({ workerId, pid, rss, heapUsed, eventLoopLagMs }) => {
          workerHealth.set(workerId, { pid, rss, heapUsed, eventLoopLagMs, lastBeatAt: Date.now() });
        });
        bind("worker:exit", ({ workerId }) => {
          workerHealth.delete(workerId);
        });

        bind("worker:recycle", ({ reason }) => {
          workerRecyclesCounter.add(1, { reason });
        });
        bind("worker:wedged", () => {
          wedgedKillsCounter.add(1);
        });
        bind("fleet:recovered", ({ degradedDurationMs }) => {
          recoveryDurationGauge.record(degradedDurationMs / 1000);
        });
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
      workerHealth.clear();
      // If the plugin's provider became the global one, release the slot:
      // metrics.disable() is the API's public unregister and restores the exact
      // pre-install state (getMeterProvider() falls back to the noop provider).
      // Restoring the captured noop prior via setGlobalMeterProvider() instead
      // would leave the slot occupied and block the app from registering later.
      if (pluginSetGlobalProvider) {
        metrics.disable();
        pluginSetGlobalProvider = false;
      }
      await shutdownProvider();
    },

    async shutdown(): Promise<void> {
      await shutdownProvider();
    },
  };
}
