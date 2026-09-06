import cluster from "node:cluster";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FleetHealth, Logger, Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
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
    quarantined: number;
    getFleetHealth: () => FleetHealth;
  };
  emitter.currentActiveWorkers = activeWorkers;
  emitter.getMetrics = () => ({ activeWorkers: emitter.currentActiveWorkers });
  emitter.workerCount = workerCount;
  emitter.quarantined = 0;
  emitter.getFleetHealth = () => ({
    target: emitter.workerCount,
    active: emitter.currentActiveWorkers,
    quarantined: emitter.quarantined,
    breaker: { count: 0, tripped: false },
  });
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

/** A minimal ResolvedConfig with workers.count = 1. */
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
// Worker health & fleet metrics
// ============================================================================

describe("worker health & fleet metrics", () => {
  it("exposes per-worker health gauges from worker:health events", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    emit(orch, "worker:health", { workerId: 7, pid: 7007, rss: 1e8, heapUsed: 5e7, eventLoopLagMs: 3 });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_worker_rss_bytes", 100000000));
    expect(out).toMatch(metricLine("clusterkit_worker_heap_used_bytes", 50000000));
    expect(out).toMatch(metricLine("clusterkit_worker_eventloop_lag_ms", 3));
  });

  it("tracks heartbeat age and drops per-worker series on worker:exit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T12:00:00.000Z"));

    const plugin = makePlugin({ metricsCacheTtlMs: 0 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    emit(orch, "worker:health", { workerId: 7, pid: 7007, rss: 1000, heapUsed: 500, eventLoopLagMs: 1 });
    vi.advanceTimersByTime(60_000);

    const before = await plugin.getMetrics();
    expect(before).toMatch(metricLine("clusterkit_worker_heartbeat_age_seconds", 60));

    emit(orch, "worker:exit", { workerId: 7, pid: 7007, code: 0, signal: null, graceful: true });
    const after = await plugin.getMetrics();
    expect(after).not.toContain("clusterkit_worker_rss_bytes{");
    expect(after).not.toContain("clusterkit_worker_heartbeat_age_seconds{");

    vi.useRealTimers();
  });

  it("counts recycles by reason and wedged kills", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    emit(orch, "worker:recycle", { workerId: 1, pid: 1, ageMs: 0, reason: "rss" });
    emit(orch, "worker:recycle", { workerId: 2, pid: 2, ageMs: 0, reason: "rss" });
    emit(orch, "worker:recycle", { workerId: 3, pid: 3, ageMs: 0, reason: "maxAge" });
    emit(orch, "worker:wedged", { workerId: 4, pid: 4, silentMs: 5000 });

    const out = await plugin.getMetrics();
    expect(out).toMatch(/clusterkit_worker_recycles_total\{reason="rss"[^}]*\} 2(?:\s|$)/);
    expect(out).toMatch(/clusterkit_worker_recycles_total\{reason="maxAge"[^}]*\} 1(?:\s|$)/);
    expect(out).toMatch(metricLine("clusterkit_worker_wedged_kills_total", 1));
  });

  it("exposes fleet gauges via live collection", async () => {
    const plugin = makePlugin({ metricsCacheTtlMs: 0 });
    const orch = mockOrchestrator(2, 2);
    await plugin.install(orch, null);

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_fleet_active_workers", 2));
    expect(out).toMatch(metricLine("clusterkit_fleet_target_workers", 2));
    expect(out).toMatch(metricLine("clusterkit_fleet_quarantined_slots", 0));

    // One worker crashes without replacement; a boot failure quarantines its slot.
    // The gauges must reflect the mutated fleet state on the next scrape.
    (orch as unknown as { currentActiveWorkers: number }).currentActiveWorkers = 1;
    (orch as unknown as { quarantined: number }).quarantined = 1;
    emit(orch, "worker:crash", { workerId: 1, pid: 1, code: 1, signal: null });
    emit(orch, "worker:quarantined", { consecutiveBootFailures: 3 });

    const after = await plugin.getMetrics();
    expect(after).toMatch(metricLine("clusterkit_fleet_active_workers", 1));
    expect(after).toMatch(metricLine("clusterkit_fleet_target_workers", 2));
    expect(after).toMatch(metricLine("clusterkit_fleet_quarantined_slots", 1));
  });

  it("reports fleet gauges as 0 when scraped before install", async () => {
    const plugin = makePlugin();

    const out = await plugin.registry.metrics();
    expect(out).toMatch(metricLine("clusterkit_fleet_active_workers", 0));
    expect(out).toMatch(metricLine("clusterkit_fleet_target_workers", 0));
    expect(out).toMatch(metricLine("clusterkit_fleet_quarantined_slots", 0));
  });

  it("records recovery duration on fleet:recovered", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    emit(orch, "fleet:recovered", { target: 2, active: 2, degradedDurationMs: 4321 });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_recovery_duration_seconds", 4.321));
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

  it("syncs the active_workers gauge to the final fleet state on uninstall", async () => {
    plugin = makePlugin();
    const orch = mockOrchestrator(2);
    await plugin.install(orch, null);

    // Workers drained without a further worker:exit event — the final
    // sync must happen in uninstall(), not in the (gone) shutdown:complete listener.
    (orch as unknown as { currentActiveWorkers: number }).currentActiveWorkers = 0;
    await plugin.uninstall?.(orch);

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_active_workers", 0));
    plugin = undefined; // already cleaned up
  });

  it("clears the merged metrics cache on uninstall", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T12:00:00.000Z"));

    let clusterMetricsCalls = 0;
    const clusterMetricsSpy = vi
      .spyOn(AggregatorRegistry.prototype, "clusterMetrics")
      .mockImplementation(async () => `plugin_cache_probe ${++clusterMetricsCalls}`);

    plugin = makePlugin({ metricsCacheTtlMs: 60_000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    await plugin.getMetrics(); // populates the cache (probe 1)
    await plugin.uninstall?.(orch);

    const after = await plugin.getMetrics(); // cache cleared → fresh collect (probe 2)
    expect(after).toContain("plugin_cache_probe 2");
    expect(clusterMetricsSpy).toHaveBeenCalledTimes(2);

    clusterMetricsSpy.mockRestore();
    vi.useRealTimers();
    plugin = undefined; // already cleaned up
  });
});

// ============================================================================
// getMetrics()
// ============================================================================

describe("getMetrics()", () => {
  it("throws when called outside the primary process", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator();
    await plugin.install(orch, null);

    const originalIsPrimary = cluster.isPrimary;
    Object.defineProperty(cluster, "isPrimary", { value: false, configurable: true });
    try {
      await expect(plugin.getMetrics()).rejects.toThrow(/getMetrics\(\) must be called in the primary/);
    } finally {
      Object.defineProperty(cluster, "isPrimary", { value: originalIsPrimary, configurable: true });
    }
  });

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
// Single worker (count 1) — the worker is forked and tracked
// ============================================================================

describe("single worker (count 1, forked)", () => {
  it("reads active_workers from live fleet state at count 1", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator(1, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_active_workers", 1));
  });

  it("does not collect default process metrics in the primary at count 1 (the forked worker reports them)", async () => {
    const registry = new Registry();
    const plugin = createPrometheusPlugin({ defaultMetrics: true, registry });
    const orch = mockOrchestrator(0, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    const out = await plugin.getMetrics();
    expect(out).not.toContain("process_cpu_user_seconds_total");
  });

  it("reads active_workers from live fleet state when workers is 'auto' and resolves to 1", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator(1, 1);
    await plugin.install(orch, null, autoWorkerConfig());

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_active_workers", 1));
  });
});

// ============================================================================
// serve() — primary-side metrics/healthz HTTP server
// ============================================================================

describe("serve()", () => {
  /** Install + serve on an ephemeral port; returns the bound server. */
  async function serveOnEphemeralPort(
    plugin: PrometheusPlugin,
    orch: Orchestrator,
    config: ResolvedConfig = singleWorkerConfig(),
  ): Promise<http.Server> {
    await plugin.install(orch, null, config);
    const server = await plugin.serve({ port: 0 });
    expect(server).toBeDefined();
    return server!;
  }

  function baseUrl(server: http.Server): string {
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("serves merged metrics on GET /metrics (primary)", async () => {
    const plugin = makePlugin();
    const server = await serveOnEphemeralPort(plugin, mockOrchestrator(3, 2));

    const res = await fetch(`${baseUrl(server)}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(plugin.registry.contentType);
    expect(await res.text()).toMatch(metricLine("clusterkit_active_workers", 3));

    await plugin.uninstall?.();
  });

  it("returns 404 for unknown paths", async () => {
    const plugin = makePlugin();
    const server = await serveOnEphemeralPort(plugin, mockOrchestrator());

    const res = await fetch(`${baseUrl(server)}/nope`);
    expect(res.status).toBe(404);

    await plugin.uninstall?.();
  });

  it("serves /healthz with a healthy payload (200)", async () => {
    const plugin = makePlugin();
    const server = await serveOnEphemeralPort(plugin, mockOrchestrator(2, 2));

    const res = await fetch(`${baseUrl(server)}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "healthy",
      target: 2,
      active: 2,
      quarantined: 0,
      breaker: { count: 0, tripped: false },
    });

    await plugin.uninstall?.();
  });

  it("serves /healthz as degraded (503) when active < target", async () => {
    const plugin = makePlugin();
    const server = await serveOnEphemeralPort(plugin, mockOrchestrator(1, 2));

    const res = await fetch(`${baseUrl(server)}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", active: 1, target: 2 });

    await plugin.uninstall?.();
  });

  it("is a no-op in worker processes (returns undefined, logs at debug)", async () => {
    const originalIsPrimary = cluster.isPrimary;
    Object.defineProperty(cluster, "isPrimary", { value: false, configurable: true });
    try {
      const plugin = makePlugin();
      const log = mockLogger();
      await plugin.install(mockOrchestrator(), log, singleWorkerConfig());
      const server = await plugin.serve({ port: 0 });
      expect(server).toBeUndefined();
      expect(log.debug.mock.calls.map((call) => String(call[0])).join("\n")).toContain("serve()");
    } finally {
      Object.defineProperty(cluster, "isPrimary", { value: originalIsPrimary, configurable: true });
    }
  });

  it("throws when called twice", async () => {
    const plugin = makePlugin();
    await serveOnEphemeralPort(plugin, mockOrchestrator());

    await expect(plugin.serve({ port: 0 })).rejects.toThrow(/serve\(\) already called/);
    await plugin.uninstall?.();
  });

  it("closes the server on uninstall", async () => {
    const plugin = makePlugin();
    const server = await serveOnEphemeralPort(plugin, mockOrchestrator());
    expect(server.listening).toBe(true);

    await plugin.uninstall?.();
    expect(server.listening).toBe(false);
  });
});

// ============================================================================
// sizing_info / max_rss_mb — scrapeable sizing plan
// ============================================================================

describe("sizing_info and max_rss_mb metrics", () => {
  it("exports sizing_info with resolved vs configured worker count", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator(0, 4);
    await plugin.install(orch, null, singleWorkerConfig());

    const out = await plugin.getMetrics();
    expect(out).toMatch(/clusterkit_sizing_info\{[^}]*computed_workers="4"[^}]*configured_workers="1"[^}]*\} 1/);
    await plugin.uninstall?.(orch);
  });

  it("exports sizing_info for 'auto' config", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator(0, 4);
    await plugin.install(orch, null, autoWorkerConfig());

    const out = await plugin.getMetrics();
    expect(out).toMatch(/clusterkit_sizing_info\{[^}]*computed_workers="4"[^}]*configured_workers="auto"/);
    await plugin.uninstall?.(orch);
  });

  it("exports max_rss_mb when RSS recycling is configured", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator(0, 2);
    await plugin.install(orch, null, {
      ...singleWorkerConfig(),
      workers: { count: 2, env: undefined, execArgv: undefined, maxAgeMs: 0, maxRssMb: 256 },
    });

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_max_rss_mb", 256));
    await plugin.uninstall?.(orch);
  });

  it("exports max_rss_mb as 0 when RSS recycling is disabled", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator(0, 2);
    await plugin.install(orch, null, singleWorkerConfig());

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_max_rss_mb", 0));
    await plugin.uninstall?.(orch);
  });

  it("removes sizing_info and max_rss_mb on uninstall", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator(0, 4);
    await plugin.install(orch, null, singleWorkerConfig());

    await plugin.uninstall?.(orch);
    const out = await plugin.getMetrics();
    expect(out).not.toContain("clusterkit_sizing_info");
    expect(out).not.toContain("clusterkit_max_rss_mb");
  });
});

// ============================================================================
// Grafana dashboard
// ============================================================================

describe("grafana dashboard", () => {
  const dashboardPath = resolve(dirname(fileURLToPath(import.meta.url)), "../grafana/clusterkit-dashboard.json");
  const readDashboard = (): Record<string, unknown> => JSON.parse(readFileSync(dashboardPath, "utf8"));

  const knownMetrics = new Set([
    "clusterkit_active_workers",
    "clusterkit_worker_restarts_total",
    "clusterkit_worker_crashes_total",
    "clusterkit_circuit_breaker_trips_total",
    "clusterkit_worker_rss_bytes",
    "clusterkit_worker_heap_used_bytes",
    "clusterkit_worker_eventloop_lag_ms",
    "clusterkit_worker_heartbeat_age_seconds",
    "clusterkit_worker_recycles_total",
    "clusterkit_worker_wedged_kills_total",
    "clusterkit_recovery_duration_seconds",
    "clusterkit_fleet_active_workers",
    "clusterkit_fleet_target_workers",
    "clusterkit_fleet_quarantined_slots",
    "clusterkit_sizing_info",
    "clusterkit_max_rss_mb",
  ]);

  it("is a valid dashboard with panels, a datasource variable, and prefix/namespace variables", () => {
    const dashboard = readDashboard();
    expect(dashboard.title).toBe("ClusterKit");
    expect(Array.isArray(dashboard.panels)).toBe(true);
    expect((dashboard.panels as unknown[]).length).toBeGreaterThan(5);
    const templating = dashboard.templating as {
      list: Array<Record<string, unknown> & { name: string; type: string }>;
    };

    const prefixVar = templating.list.find((v) => v.name === "prefix");
    expect(prefixVar?.current?.value).toBe("clusterkit_");

    const dsVar = templating.list.find((v) => v.name === "DS_PROMETHEUS");
    expect(dsVar?.type).toBe("datasource");

    const namespaceVar = templating.list.find((v) => v.name === "namespace");
    expect(namespaceVar?.type).toBe("query");
    expect(namespaceVar?.multi).toBe(true);
    expect(namespaceVar?.includeAll).toBe(true);
  });

  it("only references metrics the plugin exports", () => {
    const dashboard = readDashboard();
    const referenced = new Set<string>();
    for (const panel of dashboard.panels as Array<{ targets?: Array<{ expr: unknown }> }>) {
      for (const target of panel.targets ?? []) {
        for (const match of String(target.expr)
          .replaceAll("${prefix}", "clusterkit_")
          .matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)) {
          if (match[0].startsWith("clusterkit_")) referenced.add(match[0]);
        }
      }
    }
    expect(referenced.size).toBeGreaterThan(5);
    expect([...referenced].every((name) => knownMetrics.has(name))).toBe(true);
  });
});
