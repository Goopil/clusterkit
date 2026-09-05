import cluster from "node:cluster";
import {
  type Logger,
  type Orchestrator,
  type OrchestratorEvents,
  type ResolvedConfig,
  withLoggerPrefix,
} from "@goopil/clusterkit";
import { AggregatorRegistry, Counter, collectDefaultMetrics, Gauge, Registry } from "prom-client";
import type { PrometheusPlugin, PrometheusPluginOptions } from "./types.js";

export type { PrometheusPlugin, PrometheusPluginOptions } from "./types.js";

type PrimaryEvent =
  | "worker:online"
  | "worker:exit"
  | "worker:crash"
  | "worker:restart"
  | "circuit-breaker:tripped"
  | "worker:health"
  | "worker:recycle"
  | "worker:wedged"
  | "fleet:recovered";

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

  // Worker health & fleet metrics — driven by the health/recovery events and
  // getFleetHealth() (see spec §9.1)
  const lastReports = new Map<number, number>();
  const workerIdLabel = ["workerId"];

  const workerRss = new Gauge({
    name: `${prefix}worker_rss_bytes`,
    help: "Resident set size per worker (from health heartbeat)",
    labelNames: workerIdLabel,
    registers: [registry],
  });

  const workerHeap = new Gauge({
    name: `${prefix}worker_heap_used_bytes`,
    help: "Heap used per worker (from health heartbeat)",
    labelNames: workerIdLabel,
    registers: [registry],
  });

  const workerLag = new Gauge({
    name: `${prefix}worker_eventloop_lag_ms`,
    help: "Event loop lag per worker (from health heartbeat)",
    labelNames: workerIdLabel,
    registers: [registry],
  });

  const heartbeatAge = new Gauge({
    name: `${prefix}worker_heartbeat_age_seconds`,
    help: "Seconds since the worker's last health report (large = wedged risk)",
    labelNames: workerIdLabel,
    collect() {
      const now = Date.now();
      for (const [id, ts] of lastReports) {
        this.set({ workerId: String(id) }, (now - ts) / 1000);
      }
    },
    registers: [registry],
  });

  // Fleet gauges read the live fleet health on every scrape — no event wiring.
  // Registered for their collect() side effect only, hence no local binding.
  new Gauge({
    name: `${prefix}fleet_active_workers`,
    help: "Currently active workers (live fleet health)",
    collect() {
      this.set(primaryOrchestrator?.getFleetHealth().active ?? 0);
    },
    registers: [registry],
  });

  new Gauge({
    name: `${prefix}fleet_target_workers`,
    help: "Target worker count (live fleet health)",
    collect() {
      this.set(primaryOrchestrator?.getFleetHealth().target ?? 0);
    },
    registers: [registry],
  });

  new Gauge({
    name: `${prefix}fleet_quarantined_slots`,
    help: "Quarantined worker slots (live fleet health)",
    collect() {
      this.set(primaryOrchestrator?.getFleetHealth().quarantined ?? 0);
    },
    registers: [registry],
  });

  const workerRecycles = new Counter({
    name: `${prefix}worker_recycles_total`,
    help: "Total number of worker recycles by reason",
    labelNames: ["reason"],
    registers: [registry],
  });

  const wedgedKills = new Counter({
    name: `${prefix}worker_wedged_kills_total`,
    help: "Total number of workers killed for being wedged",
    registers: [registry],
  });

  const recoveryDuration = new Gauge({
    name: `${prefix}recovery_duration_seconds`,
    help: "Duration of the last fleet degradation until recovery",
    registers: [registry],
  });

  // Aggregates per-worker metrics from all cluster workers via prom-client built-in IPC
  const aggregatorRegistry = new AggregatorRegistry();
  let primaryOrchestrator: Orchestrator | undefined;
  let pluginLog: Logger | null = null;
  // Listeners stored payload-agnostic; the concrete payload type is inferred at
  // the bind() call site via OrchestratorEvents[E].
  const primaryListeners: Array<{ event: PrimaryEvent; listener: (...args: never[]) => void }> = [];
  let mergedMetricsCache: { value: string; expiresAt: number } | undefined;
  let inflightMetrics: Promise<string> | undefined;
  let defaultMetricsInstalled = false;
  let installedDefaultMetricNames: string[] = [];

  const clearMergedMetricsCache = (): void => {
    mergedMetricsCache = undefined;
    inflightMetrics = undefined;
  };

  const syncActiveWorkers = (): void => {
    if (!primaryOrchestrator) return;
    activeWorkers.set(primaryOrchestrator.getMetrics().activeWorkers);
  };

  const clearPrimaryListeners = (): void => {
    if (!primaryOrchestrator) return;

    for (const { event, listener } of primaryListeners) {
      primaryOrchestrator.off(event, listener);
    }

    primaryListeners.length = 0;
    primaryOrchestrator = undefined;
  };

  const clearWorkerHealth = (workerId: number): void => {
    lastReports.delete(workerId);
    workerRss.remove({ workerId: String(workerId) });
    workerHeap.remove({ workerId: String(workerId) });
    workerLag.remove({ workerId: String(workerId) });
    heartbeatAge.remove({ workerId: String(workerId) });
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

        const bind = <E extends PrimaryEvent>(event: E, listener: (...args: OrchestratorEvents[E]) => void): void => {
          orchestrator.on(event, listener);
          primaryListeners.push({ event, listener });
        };

        bind("worker:online", () => {
          syncActiveWorkers();
          clearMergedMetricsCache();
        });
        bind("worker:exit", ({ workerId }) => {
          syncActiveWorkers();
          clearMergedMetricsCache();
          clearWorkerHealth(workerId);
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
        bind("worker:health", ({ workerId, rss, heapUsed, eventLoopLagMs }) => {
          lastReports.set(workerId, Date.now());
          workerRss.set({ workerId: String(workerId) }, rss);
          workerHeap.set({ workerId: String(workerId) }, heapUsed);
          workerLag.set({ workerId: String(workerId) }, eventLoopLagMs);
        });
        bind("worker:recycle", ({ reason }) => workerRecycles.inc({ reason }));
        bind("worker:wedged", () => wedgedKills.inc());
        bind("fleet:recovered", ({ degradedDurationMs }) => recoveryDuration.set(degradedDurationMs / 1000));

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
        // Default metrics use fixed metric names, so a double install without
        // an uninstall in between would make prom-client throw on duplicate
        // registration — the latch guards that. uninstall() removes the
        // metrics again, so a reinstall re-collects them into a fresh registry.
        if (defaultMetrics && singleWorker && !defaultMetricsInstalled) {
          const known = new Set((await registry.getMetricsAsJSON()).map((metric) => metric.name));
          collectDefaultMetrics({ register: registry });
          installedDefaultMetricNames = (await registry.getMetricsAsJSON())
            .map((metric) => metric.name)
            .filter((name) => !known.has(name));
          defaultMetricsInstalled = true;
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
      // shutdown:complete fires after uninstallPlugins() in both shutdown
      // modes, so the final active_workers sync and cache reset happen here.
      syncActiveWorkers();
      clearPrimaryListeners();
      clearMergedMetricsCache();
      lastReports.clear();

      if (defaultMetricsInstalled) {
        defaultMetricsInstalled = false;
        for (const name of installedDefaultMetricNames) {
          registry.removeSingleMetric(name);
        }
        installedDefaultMetricNames = [];
      }
    },

    async getMetrics(): Promise<string> {
      if (!cluster.isPrimary) {
        throw new Error(
          "prometheus plugin: getMetrics() must be called in the primary process — orchestration metrics are only updated on the primary. Mount the /metrics endpoint on the primary; see README.md",
        );
      }
      return mergedMetrics();
    },
  };
}
