import cluster from "node:cluster";
import type { Logger, Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
import { AggregatorRegistry, Counter, collectDefaultMetrics, Gauge, Registry } from "prom-client";
import type { PrometheusMetricsRequestOptions, PrometheusPlugin, PrometheusPluginOptions } from "./types.js";

export type { PrometheusMetricsRequestOptions, PrometheusPlugin, PrometheusPluginOptions } from "./types.js";

function withLoggerPrefix(logger: Logger | null, prefix: string): Logger | null {
  if (!logger) return null;

  const wrap = (method: (msg: string, data?: Record<string, unknown>) => void) => {
    return (msg: string, data?: Record<string, unknown>): void => {
      if (data === undefined) {
        method(`[${prefix}] ${msg}`);
        return;
      }

      method(`[${prefix}] ${msg}`, data);
    };
  };

  return {
    debug: wrap(logger.debug.bind(logger)),
    info: wrap(logger.info.bind(logger)),
    warn: wrap(logger.warn.bind(logger)),
    error: wrap(logger.error.bind(logger)),
  };
}

type PrimaryEvent =
  | "worker:online"
  | "worker:exit"
  | "worker:crash"
  | "worker:restart"
  | "circuit-breaker:tripped"
  | "shutdown:complete";

// ============================================================================
// Factory
// ============================================================================

export function createPrometheusPlugin(options: PrometheusPluginOptions = {}): PrometheusPlugin {
  const {
    prefix = "clusterkit_",
    registry = new Registry(),
    defaultMetrics = true,
    metricsCacheTtlMs = 1_000,
    labels = {},
  } = options;

  if (!Number.isFinite(metricsCacheTtlMs) || metricsCacheTtlMs < 0) {
    throw new TypeError("prometheus plugin: metricsCacheTtlMs must be a finite number >= 0");
  }

  const normalizedMetricsCacheTtlMs = Math.floor(metricsCacheTtlMs);

  // Orchestration metrics — only meaningful on the primary process
  const activeWorkers = new Gauge({
    name: `${prefix}active_workers`,
    help: "Number of active cluster workers",
    registers: [registry],
  });

  const workerRestarts = new Counter({
    name: `${prefix}worker_restarts_total`,
    help: "Total number of worker restarts",
    registers: [registry],
  });

  const workerCrashes = new Counter({
    name: `${prefix}worker_crashes_total`,
    help: "Total number of worker crashes",
    registers: [registry],
  });

  const circuitBreakerTrips = new Counter({
    name: `${prefix}circuit_breaker_trips_total`,
    help: "Total number of circuit breaker trips",
    registers: [registry],
  });

  // Aggregates per-worker metrics from all cluster workers via prom-client built-in IPC
  const aggregatorRegistry = new AggregatorRegistry();
  let primaryOrchestrator: Orchestrator | undefined;
  let pluginLog: Logger | null = null;
  const primaryListeners: Array<{ event: PrimaryEvent; listener: () => void }> = [];
  let mergedMetricsCache: { value: string; expiresAt: number } | undefined;

  const clearMergedMetricsCache = (): void => {
    mergedMetricsCache = undefined;
  };

  const clearPrimaryListeners = (): void => {
    if (!primaryOrchestrator) return;

    for (const { event, listener } of primaryListeners) {
      primaryOrchestrator.off(event, listener);
    }

    primaryListeners.length = 0;
    primaryOrchestrator = undefined;
  };

  async function mergedMetrics(options: PrometheusMetricsRequestOptions = {}): Promise<string> {
    const { bypassCache = false } = options;
    const now = Date.now();

    if (!bypassCache && normalizedMetricsCacheTtlMs > 0 && mergedMetricsCache && mergedMetricsCache.expiresAt > now) {
      return mergedMetricsCache.value;
    }

    // A worker dying mid-scrape (crash loop, recycle) makes clusterMetrics()
    // reject after prom-client's internal 5s timeout — degrade to
    // orchestration-only metrics instead of failing the whole scrape.
    const collectWorkerMetrics = async (): Promise<string> => {
      try {
        return await aggregatorRegistry.clusterMetrics();
      } catch (err) {
        pluginLog?.warn("Worker metrics aggregation failed — serving orchestration metrics only", {
          error: err instanceof Error ? err.message : String(err),
        });
        return "";
      }
    };

    const [orchestration, workers] = await Promise.all([registry.metrics(), collectWorkerMetrics()]);
    const value = workers ? `${orchestration}\n${workers}` : orchestration;

    if (normalizedMetricsCacheTtlMs > 0 && !bypassCache) {
      mergedMetricsCache = {
        value,
        expiresAt: now + normalizedMetricsCacheTtlMs,
      };
    }

    return value;
  }

  return {
    name: "prometheus",
    registry,

    async install(orchestrator: Orchestrator, logger: Logger | null, config: ResolvedConfig): Promise<void> {
      const log = withLoggerPrefix(logger, "clusterkit:prometheus");
      pluginLog = log;

      if (cluster.isPrimary) {
        clearPrimaryListeners();
        clearMergedMetricsCache();
        primaryOrchestrator = orchestrator;
        log?.debug("Plugin installed on primary process");

        const syncActiveWorkers = () => {
          activeWorkers.set(orchestrator.getMetrics().activeWorkers);
        };

        const bind = (event: PrimaryEvent, listener: () => void): void => {
          orchestrator.on(event, listener);
          primaryListeners.push({ event, listener });
        };

        bind("worker:online", () => {
          syncActiveWorkers();
          clearMergedMetricsCache();
        });
        bind("worker:exit", () => {
          syncActiveWorkers();
          clearMergedMetricsCache();
        });
        bind("worker:crash", () => {
          workerCrashes.inc();
          clearMergedMetricsCache();
        });
        bind("worker:restart", () => {
          workerRestarts.inc();
          clearMergedMetricsCache();
        });
        bind("circuit-breaker:tripped", () => {
          circuitBreakerTrips.inc();
          clearMergedMetricsCache();
        });
        bind("shutdown:complete", () => {
          syncActiveWorkers();
          clearMergedMetricsCache();
        });

        registry.setDefaultLabels({ pid: process.pid, ...labels });

        // Single-worker mode (workers: 1): the orchestrator runs the app in
        // the primary process without forking — no worker:online event fires,
        // so we seed the gauge to 1 (the primary IS the worker). In
        // multi-worker mode, syncActiveWorkers() reads the current count.
        const singleWorker = config?.workers.count === 1;
        if (singleWorker) {
          activeWorkers.set(1);
        } else {
          syncActiveWorkers();
        }

        // Single-worker mode: collect default process metrics here since
        // there are no worker processes to collect them via AggregatorRegistry.
        if (defaultMetrics && singleWorker) {
          collectDefaultMetrics({ register: registry });
        }
      } else {
        log?.debug("Plugin installed on worker process");

        // Each worker collects its own default metrics.
        // prom-client's AggregatorRegistry on the primary will harvest them via built-in IPC.
        const workerRegistry = new Registry();
        workerRegistry.setDefaultLabels({ pid: process.pid, ...labels });

        if (defaultMetrics) {
          collectDefaultMetrics({ register: workerRegistry });
        }

        AggregatorRegistry.setRegistries([workerRegistry]);
      }
    },

    async uninstall(): Promise<void> {
      clearPrimaryListeners();
      clearMergedMetricsCache();
    },

    async getMetrics(options: PrometheusMetricsRequestOptions = {}): Promise<string> {
      return mergedMetrics(options);
    },
  };
}
