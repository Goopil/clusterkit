import cluster from "node:cluster";
import { type Logger, type Orchestrator, type ResolvedConfig, withLoggerPrefix } from "@goopil/clusterkit";
import { AggregatorRegistry, Counter, collectDefaultMetrics, Gauge, Registry } from "prom-client";
import type { PrometheusPlugin, PrometheusPluginOptions } from "./types.js";

export type { PrometheusPlugin, PrometheusPluginOptions } from "./types.js";

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
  let inflightMetrics: Promise<string> | undefined;
  let defaultMetricsInstalled = false;

  const clearMergedMetricsCache = (): void => {
    mergedMetricsCache = undefined;
    inflightMetrics = undefined;
  };

  const clearPrimaryListeners = (): void => {
    if (!primaryOrchestrator) return;

    for (const { event, listener } of primaryListeners) {
      primaryOrchestrator.off(event, listener);
    }

    primaryListeners.length = 0;
    primaryOrchestrator = undefined;
  };

  async function mergedMetrics(): Promise<string> {
    const now = Date.now();

    if (normalizedMetricsCacheTtlMs > 0 && mergedMetricsCache && mergedMetricsCache.expiresAt > now) {
      return mergedMetricsCache.value;
    }

    if (inflightMetrics) {
      return inflightMetrics;
    }

    const collect = async (): Promise<string> => {
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

      if (normalizedMetricsCacheTtlMs > 0) {
        mergedMetricsCache = {
          value,
          expiresAt: Date.now() + normalizedMetricsCacheTtlMs,
        };
      }

      return value;
    };

    inflightMetrics = collect().finally(() => {
      inflightMetrics = undefined;
    });
    return inflightMetrics;
  }

  return {
    name: "prometheus",
    registry,

    async install(orchestrator: Orchestrator, logger: Logger | null, _config: ResolvedConfig): Promise<void> {
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

        // Single-worker mode: the orchestrator runs the app in the primary
        // process without forking — no worker:online event fires, so we
        // seed the gauge to 1 (the primary IS the worker). We use the
        // resolved workerCount (not config.workers.count) because plugins
        // install before resolveWorkerCount() runs in runPrimary(), so
        // config may still hold "auto". Reading workerCount here triggers
        // the sync cgroup read once; the orchestrator's subsequent
        // resolveWorkerCount() call hits the cache, so no redundant fs I/O.
        const singleWorker = orchestrator.workerCount === 1;
        if (singleWorker) {
          activeWorkers.set(1);
        } else {
          syncActiveWorkers();
        }

        // Single-worker mode: collect default process metrics here since
        // there are no worker processes to collect them via AggregatorRegistry.
        // collectDefaultMetrics registers fixed metric names into the shared
        // registry — reinstalling the plugin must not register them twice
        // (prom-client throws on duplicate metric names).
        if (defaultMetrics && singleWorker && !defaultMetricsInstalled) {
          defaultMetricsInstalled = true;
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

    async getMetrics(): Promise<string> {
      return mergedMetrics();
    },
  };
}
