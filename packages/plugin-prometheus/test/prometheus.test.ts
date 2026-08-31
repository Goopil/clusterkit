import { EventEmitter } from "node:events";
import type { Logger, Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
import { AggregatorRegistry, Registry } from "prom-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrometheusPlugin, type PrometheusPlugin, type PrometheusPluginOptions } from "../src/index";

// ============================================================================
// Helpers
// ============================================================================

/** Cast a plain EventEmitter to Orchestrator for testing (plugin only calls .on()). */
function mockOrchestrator(activeWorkers = 0, workerCount = 0): Orchestrator {
  const emitter = new EventEmitter() as EventEmitter & {
    currentActiveWorkers: number;
    getMetrics: () => { activeWorkers: number };
    workerCount: number;
  };
  emitter.currentActiveWorkers = activeWorkers;
  emitter.getMetrics = () => ({ activeWorkers: emitter.currentActiveWorkers });
  emitter.workerCount = workerCount;
  return emitter as unknown as Orchestrator;
}

/** Emit a typed event on the mock orchestrator. */
function emit(orch: Orchestrator, event: string, data: unknown): void {
  (orch as unknown as EventEmitter).emit(event, data);
}

/** Create a plugin pre-configured for unit tests (no server, no default metrics). */
function makePlugin(opts: PrometheusPluginOptions = {}): PrometheusPlugin {
  return createPrometheusPlugin({
    defaultMetrics: false,
    registry: new Registry(),
    ...opts,
  });
}

/**
 * Returns a regex that matches a Prometheus metric line regardless of labels.
 * Matches both `metric_name VALUE` and `metric_name{label="x",...} VALUE`.
 */
function metricLine(name: string, value: number | string): RegExp {
  return new RegExp(`${name}(?:\\{[^}]*\\})? ${value}(?:\\s|$)`, "m");
}

type LoggerSpy = Logger & {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function mockLogger(): LoggerSpy {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** A minimal ResolvedConfig with workers.count = 1 (single-worker mode). */
function singleWorkerConfig(): ResolvedConfig {
  return {
    logger: null,
    workers: { count: 1, env: undefined, execArgv: undefined, maxAgeMs: 0 },
    restart: {
      crashThreshold: 5,
      crashWindowMs: 60_000,
      backoffMs: 1_000,
      maxBackoffMs: 30_000,
      backoffMultiplier: 2,
      stabilityWindowMs: 30_000,
    },
    shutdown: {
      timeoutMs: 12_000,
      ackTimeoutMs: 3_000,
      messagePrefix: "__wm",
      sigtermDelayMs: 2_000,
      sigintDelayMs: 1_000,
    },
    clusterModule: undefined,
  };
}

/** A minimal ResolvedConfig with workers.count = 'auto'. */
function autoWorkerConfig(): ResolvedConfig {
  return { ...singleWorkerConfig(), workers: { count: "auto", env: undefined, execArgv: undefined, maxAgeMs: 0 } };
}

// ============================================================================
// Interface conformance
// ============================================================================

describe("PrometheusPlugin interface", () => {
  it("has the required OrchestratorPlugin fields", () => {
    const plugin = makePlugin();
    expect(plugin.name).toBe("prometheus");
    expect(typeof plugin.install).toBe("function");
    expect(typeof plugin.uninstall).toBe("function");
  });

  it("exposes the extra API", () => {
    const plugin = makePlugin();
    expect(typeof plugin.getMetrics).toBe("function");
    expect(plugin.registry).toBeInstanceOf(Registry);
  });
});

// ============================================================================
// Metrics — event → counter / gauge
// ============================================================================

describe("metrics", () => {
  it("does not collect primary default process metrics into the orchestration registry", async () => {
    const plugin = createPrometheusPlugin({
      defaultMetrics: true,
      registry: new Registry(),
    });
    const orch = mockOrchestrator();

    await plugin.install(orch, null);

    const out = await plugin.registry.metrics();
    expect(out).not.toContain("process_cpu_user_seconds_total");
    expect(out).not.toContain("nodejs_eventloop_lag_seconds");
  });

  it("worker:online increments active_workers gauge", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    (orch as unknown as { currentActiveWorkers: number }).currentActiveWorkers = 1;
    emit(orch, "worker:online", { workerId: 1, pid: 1234 });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_active_workers", 1));
  });

  it("worker:crash decrements active_workers and increments worker_crashes_total", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    emit(orch, "worker:online", { workerId: 1, pid: 1234 });
    (orch as unknown as { currentActiveWorkers: number }).currentActiveWorkers = 0;
    emit(orch, "worker:crash", { workerId: 1, pid: 1234, code: 1, signal: null });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_active_workers", 0));
    expect(out).toMatch(metricLine("clusterkit_worker_crashes_total", 1));
  });

  it("worker:exit keeps active_workers gauge in sync after a graceful exit", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    emit(orch, "worker:online", { workerId: 1, pid: 1234 });
    (orch as unknown as { currentActiveWorkers: number }).currentActiveWorkers = 0;
    emit(orch, "worker:exit", { workerId: 1, pid: 1234, code: 0, signal: null, graceful: true });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_active_workers", 0));
  });

  it("worker:restart increments worker_restarts_total", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    emit(orch, "worker:restart", { newWorkerId: 2, newPid: 5678 });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_worker_restarts_total", 1));
  });

  it("circuit-breaker:tripped increments circuit_breaker_trips_total", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    emit(orch, "circuit-breaker:tripped", { crashCount: 5, windowMs: 60000 });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_circuit_breaker_trips_total", 1));
  });

  it("counters accumulate across multiple events", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    emit(orch, "worker:restart", { newWorkerId: 2, newPid: 2 });
    emit(orch, "worker:restart", { newWorkerId: 3, newPid: 3 });
    emit(orch, "worker:restart", { newWorkerId: 4, newPid: 4 });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_worker_restarts_total", 3));
  });

  it("does not duplicate event listeners after uninstall and reinstall", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();

    await plugin.install(orch, null);
    emit(orch, "worker:restart", { newWorkerId: 1, newPid: 1 });

    await plugin.uninstall?.(orch);
    await plugin.install(orch, null);
    emit(orch, "worker:restart", { newWorkerId: 2, newPid: 2 });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_worker_restarts_total", 2));
  });

  it("custom prefix is applied to all metric names", async () => {
    const plugin = makePlugin({ prefix: "myapp_" });
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    (orch as unknown as { currentActiveWorkers: number }).currentActiveWorkers = 1;
    emit(orch, "worker:online", { workerId: 1, pid: 1 });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("myapp_active_workers", 1));
    expect(out).not.toContain("clusterkit_active_workers");
  });

  it("custom labels appear on all metrics", async () => {
    const plugin = makePlugin({ labels: { env: "test", region: "eu-west-1" } });
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    (orch as unknown as { currentActiveWorkers: number }).currentActiveWorkers = 1;
    emit(orch, "worker:online", { workerId: 1, pid: 1 });

    const out = await plugin.getMetrics();
    expect(out).toContain('env="test"');
    expect(out).toContain('region="eu-west-1"');
    expect(out).toContain(`pid="${process.pid}"`);
  });
});

// ============================================================================
// Plugin lifecycle logging
// ============================================================================

describe("plugin lifecycle", () => {
  let plugin: PrometheusPlugin | undefined;

  afterEach(async () => {
    if (plugin) {
      await plugin.uninstall?.(mockOrchestrator());
    }
    plugin = undefined;
  });

  it("prefixes install logs with the plugin component tag", async () => {
    const logger = mockLogger();
    plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, logger);

    expect(logger.debug).toHaveBeenCalledWith("[clusterkit:prometheus] Plugin installed on primary process", undefined);
  });

  it("clears listeners and cache on uninstall", async () => {
    const logger = mockLogger();
    plugin = makePlugin({ metricsCacheTtlMs: 1_000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, logger);

    await plugin.getMetrics();
    await plugin.uninstall?.(orch);

    expect(logger.debug).toHaveBeenCalledWith("[clusterkit:prometheus] Plugin installed on primary process", undefined);
    plugin = undefined; // already cleaned up
  });
});

// ============================================================================
// getMetrics()
// ============================================================================

describe("getMetrics()", () => {
  it("returns a string after install()", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    const out = await plugin.getMetrics();
    expect(typeof out).toBe("string");
  });

  it("reflects orchestration metric values", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    (orch as unknown as { currentActiveWorkers: number }).currentActiveWorkers = 1;
    emit(orch, "worker:online", { workerId: 1, pid: 1 });
    (orch as unknown as { currentActiveWorkers: number }).currentActiveWorkers = 2;
    emit(orch, "worker:online", { workerId: 2, pid: 2 });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_active_workers", 2));
  });

  it("reuses merged metrics cache within ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T12:00:00.000Z"));

    let clusterMetricsCalls = 0;
    const clusterMetricsSpy = vi
      .spyOn(AggregatorRegistry.prototype, "clusterMetrics")
      .mockImplementation(async () => `plugin_cache_probe ${++clusterMetricsCalls}`);

    const plugin = makePlugin({ metricsCacheTtlMs: 1_000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    const first = await plugin.getMetrics();
    const second = await plugin.getMetrics();

    expect(first).toContain("plugin_cache_probe 1");
    expect(second).toContain("plugin_cache_probe 1");
    expect(clusterMetricsSpy).toHaveBeenCalledTimes(1);

    clusterMetricsSpy.mockRestore();
    vi.useRealTimers();
  });

  it("refreshes merged metrics cache after ttl expiration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T12:00:00.000Z"));

    let clusterMetricsCalls = 0;
    const clusterMetricsSpy = vi
      .spyOn(AggregatorRegistry.prototype, "clusterMetrics")
      .mockImplementation(async () => `plugin_cache_probe ${++clusterMetricsCalls}`);

    const plugin = makePlugin({ metricsCacheTtlMs: 100 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    const first = await plugin.getMetrics();
    vi.advanceTimersByTime(101);
    const second = await plugin.getMetrics();

    expect(first).toContain("plugin_cache_probe 1");
    expect(second).toContain("plugin_cache_probe 2");
    expect(clusterMetricsSpy).toHaveBeenCalledTimes(2);

    clusterMetricsSpy.mockRestore();
    vi.useRealTimers();
  });

  it("degrades to orchestration metrics when worker aggregation fails", async () => {
    // A worker dying mid-scrape makes clusterMetrics() reject after
    // prom-client's 5s internal timeout — the scrape must not fail with it
    const clusterMetricsSpy = vi
      .spyOn(AggregatorRegistry.prototype, "clusterMetrics")
      .mockRejectedValue(new Error("Operation timed out."));

    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    emit(orch, "worker:crash", { workerId: 1, pid: 1234, code: 1, signal: null });

    const out = await plugin.getMetrics();
    expect(out).toContain("clusterkit_worker_crashes_total");

    clusterMetricsSpy.mockRestore();
  });

  it("deduplicates concurrent getMetrics() calls via in-flight promise", async () => {
    let clusterMetricsCalls = 0;
    const clusterMetricsSpy = vi.spyOn(AggregatorRegistry.prototype, "clusterMetrics").mockImplementation(async () => {
      clusterMetricsCalls++;
      await new Promise((r) => setTimeout(r, 50));
      return `plugin_cache_probe ${clusterMetricsCalls}`;
    });

    const plugin = makePlugin({ metricsCacheTtlMs: 1_000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    const [a, b, c] = await Promise.all([plugin.getMetrics(), plugin.getMetrics(), plugin.getMetrics()]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(clusterMetricsCalls).toBe(1);

    clusterMetricsSpy.mockRestore();
  });

  it("rejects invalid metricsCacheTtlMs values", () => {
    expect(() => makePlugin({ metricsCacheTtlMs: -1 })).toThrow(
      "prometheus plugin: metricsCacheTtlMs must be a finite number >= 0",
    );
    expect(() => makePlugin({ metricsCacheTtlMs: Number.NaN })).toThrow(
      "prometheus plugin: metricsCacheTtlMs must be a finite number >= 0",
    );
  });
});

// ============================================================================
// Single-worker mode (cluster.isPrimary with no fork)
// ============================================================================

describe("single-worker mode", () => {
  it("sets active_workers to 1 when workerCount resolves to 1 (primary IS the worker)", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator(0, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_active_workers", 1));
  });

  it("collects default process metrics in the primary in single-worker mode", async () => {
    const registry = new Registry();
    const plugin = createPrometheusPlugin({
      defaultMetrics: true,
      registry,
    });
    const orch = mockOrchestrator(0, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    const out = await plugin.getMetrics();
    expect(out).toContain("process_cpu_user_seconds_total");
  });

  it("sets active_workers to 1 when workers is 'auto' and resolves to 1", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator(0, 1);
    await plugin.install(orch, null, autoWorkerConfig());

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_active_workers", 1));
  });
});
