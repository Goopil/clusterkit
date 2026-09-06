import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { FleetHealth, Logger, Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
import type { MeterProvider as MeterProviderType } from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHostMetricsStart = vi.fn();

// Captures the config each mocked exporter constructor receives, so tests can
// assert which options the plugin forwards.
const exporterCtorArgs = vi.hoisted(() => ({
  http: [] as unknown[],
  grpc: [] as unknown[],
}));

const capturedExports = vi.hoisted(() => [] as unknown[]);

vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: class {
    constructor(config: unknown) {
      exporterCtorArgs.http.push(config);
    }
    async export(metrics: unknown, cb: (r: { status: number }) => void) {
      capturedExports.push(metrics);
      cb({ status: 0 });
    }
    async shutdown() {}
    async forceFlush() {}
  },
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-grpc", () => ({
  OTLPMetricExporter: class {
    constructor(config: unknown) {
      exporterCtorArgs.grpc.push(config);
    }
    async export(metrics: unknown, cb: (r: { status: number }) => void) {
      capturedExports.push(metrics);
      cb({ status: 0 });
    }
    async shutdown() {}
    async forceFlush() {}
  },
}));

vi.mock("@opentelemetry/host-metrics", () => ({
  HostMetrics: class {
    start() {
      mockHostMetricsStart();
    }
  },
}));

beforeEach(() => {
  mockHostMetricsStart.mockClear();
  exporterCtorArgs.http.length = 0;
  exporterCtorArgs.grpc.length = 0;
  capturedExports.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// Helpers (reused by later tasks) ===========================================

function mockOrchestrator(activeWorkers = 0, workerCount = 0): Orchestrator {
  const emitter = new EventEmitter() as EventEmitter & {
    currentActiveWorkers: number;
    getMetrics: () => { activeWorkers: number };
    workerCount: number;
    quarantined: number;
    getFleetHealth: () => FleetHealth;
    registerOnShutdown: (cb: () => void | Promise<void>) => void;
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
  emitter.registerOnShutdown = () => {};
  return emitter as unknown as Orchestrator;
}

function emit(orch: Orchestrator, event: string, data: unknown): void {
  (orch as unknown as EventEmitter).emit(event, data);
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

function autoWorkerConfig(): ResolvedConfig {
  return { ...singleWorkerConfig(), workers: { count: "auto", env: undefined, execArgv: undefined, maxAgeMs: 0 } };
}

type CounterSpies = Record<string, ReturnType<typeof vi.fn>>;

async function spyOnCounters(): Promise<{
  spies: CounterSpies;
  restore: () => void;
}> {
  const spies: CounterSpies = {};
  const sdkMod = await import("@opentelemetry/sdk-metrics");
  const MeterProvider = sdkMod.MeterProvider as typeof MeterProviderType;
  const origGetMeter = MeterProvider.prototype.getMeter;

  MeterProvider.prototype.getMeter = function (this: MeterProvider, ...args: Parameters<typeof origGetMeter>) {
    const meter = origGetMeter.apply(this, args);
    const origCreateCounter = meter.createCounter.bind(meter);
    meter.createCounter = ((name: string) => {
      const counter = origCreateCounter(name);
      spies[name] = vi.spyOn(counter, "add");
      return counter;
    }) as typeof meter.createCounter;
    return meter;
  } as typeof origGetMeter;

  return {
    spies,
    restore: () => {
      MeterProvider.prototype.getMeter = origGetMeter;
    },
  };
}

type HealthDataPoint = { attributes: Record<string, string | number>; value: number };

/**
 * Collect the data points observed for a metric name in the most recent export
 * batch that contains it (SDK timestamps stripped; the latest batch reflects
 * the current gauge state).
 */
function findPoints(metricName: string): HealthDataPoint[] {
  for (let i = capturedExports.length - 1; i >= 0; i--) {
    const { scopeMetrics } = capturedExports[i] as {
      scopeMetrics?: Array<{ metrics?: Array<{ descriptor: { name: string }; dataPoints?: HealthDataPoint[] }> }>;
    };
    for (const scope of scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        if (metric.descriptor.name === metricName) {
          return (metric.dataPoints ?? []).map(({ attributes, value }) => ({ attributes, value }));
        }
      }
    }
  }
  return [];
}

// Interface conformance =====================================================

describe("OtlpMeterPlugin interface", () => {
  it("has the required OrchestratorPlugin fields", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false });
    expect(plugin.name).toBe("otlp-meter");
    expect(typeof plugin.install).toBe("function");
    expect(typeof plugin.uninstall).toBe("function");
  });

  it("exposes meterProvider as undefined before install", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false });
    expect(plugin.meterProvider).toBeUndefined();
  });
});

// Options validation ========================================================

describe("options validation", () => {
  it("rejects negative exportIntervalMs", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    expect(() => createOtlpMeterPlugin({ exportIntervalMs: -1, instrumentation: false })).toThrow();
  });

  it("rejects NaN exportIntervalMs", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    expect(() => createOtlpMeterPlugin({ exportIntervalMs: Number.NaN, instrumentation: false })).toThrow();
  });

  it("rejects invalid http endpoint URL", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    expect(() => createOtlpMeterPlugin({ endpoint: "not-a-url", instrumentation: false })).toThrow(
      /invalid endpoint URL/,
    );
  });

  it("rejects exportIntervalMs below the 1000ms floor", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    expect(() => createOtlpMeterPlugin({ exportIntervalMs: 500, instrumentation: false })).toThrow(
      /exportIntervalMs must be a finite number >= 1000/,
    );
  });

  it("accepts exportIntervalMs at the 1000ms floor", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ exportIntervalMs: 1000, instrumentation: false });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    expect(plugin.meterProvider).toBeDefined();
    await plugin.uninstall?.(orch);
  });

  it("accepts exportIntervalMs above the floor (1500)", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ exportIntervalMs: 1500, instrumentation: false });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    expect(plugin.meterProvider).toBeDefined();
    await plugin.uninstall?.(orch);
  });
});

// Event → counter mapping ===================================================

describe("metrics — event to counter mapping", () => {
  it("worker:crash increments worker.crashes counter", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:crash", { workerId: 1, pid: 1234, code: 1, signal: null });

    expect(spies["clusterkit.worker.crashes"]).toHaveBeenCalledTimes(1);
    expect(spies["clusterkit.worker.crashes"]).toHaveBeenCalledWith(1);
    restore();
    await plugin.uninstall?.(orch);
  });

  it("worker:restart increments worker.restarts counter", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:restart", { newWorkerId: 2, newPid: 5678 });

    expect(spies["clusterkit.worker.restarts"]).toHaveBeenCalledTimes(1);
    expect(spies["clusterkit.worker.restarts"]).toHaveBeenCalledWith(1);
    restore();
    await plugin.uninstall?.(orch);
  });

  it("circuit-breaker:tripped increments circuit_breaker.trips counter", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "circuit-breaker:tripped", { crashCount: 5, windowMs: 60000 });

    expect(spies["clusterkit.circuit_breaker.trips"]).toHaveBeenCalledTimes(1);
    expect(spies["clusterkit.circuit_breaker.trips"]).toHaveBeenCalledWith(1);
    restore();
    await plugin.uninstall?.(orch);
  });

  it("counters accumulate across multiple events", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:restart", { newWorkerId: 2, newPid: 2 });
    emit(orch, "worker:restart", { newWorkerId: 3, newPid: 3 });
    emit(orch, "worker:restart", { newWorkerId: 4, newPid: 4 });

    expect(spies["clusterkit.worker.restarts"]).toHaveBeenCalledTimes(3);
    restore();
    await plugin.uninstall?.(orch);
  });

  it("does not duplicate event listeners after uninstall and reinstall", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, singleWorkerConfig());
    emit(orch, "worker:restart", { newWorkerId: 1, newPid: 1 });

    await plugin.uninstall?.(orch);
    await plugin.install(orch, null, singleWorkerConfig());
    emit(orch, "worker:restart", { newWorkerId: 2, newPid: 2 });

    expect(spies["clusterkit.worker.restarts"]).toHaveBeenCalledTimes(1);
    restore();
    await plugin.uninstall?.(orch);
  });
});

describe("metrics — worker health gauges", () => {
  it("worker:health populates per-worker gauges with worker.id and process.pid attributes", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:health", { workerId: 7, pid: 7007, rss: 1000, heapUsed: 500, eventLoopLagMs: 12 });
    emit(orch, "worker:health", { workerId: 8, pid: 8008, rss: 2000, heapUsed: 900, eventLoopLagMs: 34 });

    await plugin.meterProvider!.forceFlush();

    expect(findPoints("clusterkit.worker.rss_bytes")).toEqual([
      { attributes: { "worker.id": 7, "process.pid": 7007 }, value: 1000 },
      { attributes: { "worker.id": 8, "process.pid": 8008 }, value: 2000 },
    ]);
    expect(findPoints("clusterkit.worker.heap_used_bytes")).toEqual([
      { attributes: { "worker.id": 7, "process.pid": 7007 }, value: 500 },
      { attributes: { "worker.id": 8, "process.pid": 8008 }, value: 900 },
    ]);
    expect(findPoints("clusterkit.worker.eventloop_lag_ms")).toEqual([
      { attributes: { "worker.id": 7, "process.pid": 7007 }, value: 12 },
      { attributes: { "worker.id": 8, "process.pid": 8008 }, value: 34 },
    ]);

    await plugin.uninstall?.(orch);
  });

  it("worker.heartbeat_age_seconds grows with time since the last heartbeat", async () => {
    vi.useFakeTimers();
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:health", { workerId: 3, pid: 3003, rss: 1, heapUsed: 1, eventLoopLagMs: 1 });
    vi.advanceTimersByTime(60_000);

    await plugin.meterProvider!.forceFlush();
    expect(findPoints("clusterkit.worker.heartbeat_age_seconds")).toEqual([
      { attributes: { "worker.id": 3, "process.pid": 3003 }, value: 60 },
    ]);

    await plugin.uninstall?.(orch);
    vi.useRealTimers();
  });

  it("worker:exit stops emitting the worker's series", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:health", { workerId: 9, pid: 9009, rss: 1, heapUsed: 2, eventLoopLagMs: 3 });
    emit(orch, "worker:exit", { workerId: 9, pid: 9009, code: 0, signal: null, graceful: true });
    await plugin.meterProvider!.forceFlush();

    expect(findPoints("clusterkit.worker.rss_bytes")).toEqual([]);

    await plugin.uninstall?.(orch);
  });

  it("uninstall clears health state so a reinstall starts fresh", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:health", { workerId: 5, pid: 5005, rss: 10, heapUsed: 20, eventLoopLagMs: 30 });
    await plugin.uninstall?.(orch);
    await plugin.install(orch, null, singleWorkerConfig());

    await plugin.meterProvider!.forceFlush();
    expect(findPoints("clusterkit.worker.rss_bytes")).toEqual([]);

    await plugin.uninstall?.(orch);
  });
});

describe("metrics — recovery and fleet", () => {
  it("worker:recycle increments worker.recycles with the reason attribute", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:recycle", { workerId: 1, pid: 1, ageMs: 0, reason: "rss" });
    emit(orch, "worker:recycle", { workerId: 2, pid: 2, ageMs: 0, reason: "maxAge" });
    emit(orch, "worker:recycle", { workerId: 3, pid: 3, ageMs: 0, reason: "wedged" });

    expect(spies["clusterkit.worker.recycles"]).toHaveBeenCalledWith(1, { reason: "rss" });
    expect(spies["clusterkit.worker.recycles"]).toHaveBeenCalledWith(1, { reason: "maxAge" });
    expect(spies["clusterkit.worker.recycles"]).toHaveBeenCalledWith(1, { reason: "wedged" });

    restore();
    await plugin.uninstall?.(orch);
  });

  it("worker:wedged increments worker.wedged.kills", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:wedged", { workerId: 4, pid: 4, silentMs: 5000 });

    expect(spies["clusterkit.worker.wedged.kills"]).toHaveBeenCalledTimes(1);

    restore();
    await plugin.uninstall?.(orch);
  });

  it("fleet gauges observe live getFleetHealth() values", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator(2, 2);
    await plugin.install(orch, null, singleWorkerConfig());

    (orch as unknown as { currentActiveWorkers: number }).currentActiveWorkers = 1;
    (orch as unknown as { quarantined: number }).quarantined = 1;

    await plugin.meterProvider!.forceFlush();

    expect(findPoints("clusterkit.fleet.active_workers")).toEqual([{ attributes: {}, value: 1 }]);
    expect(findPoints("clusterkit.fleet.target_workers")).toEqual([{ attributes: {}, value: 2 }]);
    expect(findPoints("clusterkit.fleet.quarantined_slots")).toEqual([{ attributes: {}, value: 1 }]);

    await plugin.uninstall?.(orch);
  });

  it("fleet:recovered records recovery.duration_seconds", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "fleet:recovered", { target: 2, active: 2, degradedDurationMs: 4321 });

    await plugin.meterProvider!.forceFlush();

    expect(findPoints("clusterkit.recovery.duration_seconds")).toEqual([{ attributes: {}, value: 4.321 }]);

    await plugin.uninstall?.(orch);
  });

  it("no recycle listeners fire after uninstall", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());
    await plugin.uninstall?.(orch);

    emit(orch, "worker:recycle", { workerId: 1, pid: 1, ageMs: 0, reason: "rss" });

    expect(spies["clusterkit.worker.recycles"]).not.toHaveBeenCalled();

    restore();
  });
});

// Shutdown safety ===========================================================

describe("shutdown safety", () => {
  it("flushes and closes the provider when shutdown() is called manually", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());
    expect(plugin.meterProvider).toBeDefined();

    await plugin.shutdown();

    expect(plugin.meterProvider).toBeUndefined();
  });

  it("does not throw when uninstall() is called twice", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    await plugin.uninstall?.(orch);
    await expect(plugin.uninstall?.(orch)).resolves.not.toThrow();
  });

  it("does not throw when the shutdown callback and uninstall() both fire", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    let shutdownCb: (() => void | Promise<void>) | undefined;
    const orch = mockOrchestrator();
    (orch as unknown as { registerOnShutdown: (cb: typeof shutdownCb) => void }).registerOnShutdown = (cb) => {
      shutdownCb = cb;
    };
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    await plugin.install(orch, null, singleWorkerConfig());

    await shutdownCb?.();
    await expect(plugin.uninstall?.(orch)).resolves.not.toThrow();
  });

  it("resets the shutdown latch on reinstall so the new provider can be shut down", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, singleWorkerConfig());
    const first = plugin.meterProvider;
    await plugin.uninstall?.(orch);
    expect(plugin.meterProvider).toBeUndefined();

    // Reinstall the same instance after shutdown: the new provider must be usable
    await plugin.install(orch, null, singleWorkerConfig());
    const second = plugin.meterProvider;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    // The latch was reset: uninstall() must actually shut down the new provider
    await plugin.uninstall?.(orch);
    expect(plugin.meterProvider).toBeUndefined();
  });
});

// Plugin lifecycle logging ===================================================

describe("plugin lifecycle", () => {
  it("prefixes install logs with the plugin component tag", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const logger = mockLogger();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, logger, singleWorkerConfig());

    expect(logger.debug).toHaveBeenCalledWith("[clusterkit:otlp-meter] Plugin installed on primary process", undefined);
    await plugin.uninstall?.(orch);
  });

  it("clears listeners on uninstall", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    expect((orch as unknown as EventEmitter).listenerCount("worker:crash")).toBe(1);

    await plugin.uninstall?.(orch);

    expect((orch as unknown as EventEmitter).listenerCount("worker:crash")).toBe(0);
    await plugin.uninstall?.(orch);
  });

  it("flushes the meter provider on uninstall", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    expect(plugin.meterProvider).toBeDefined();

    await plugin.uninstall?.(orch);

    expect(plugin.meterProvider).toBeUndefined();
  });
});

// Single worker (count 1, forked) ============================================

describe("single worker (count 1, forked)", () => {
  it("creates meter provider when workerCount is 1", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator(0, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    expect(plugin.meterProvider).toBeDefined();
    await plugin.uninstall?.(orch);
  });

  it("creates meter provider when workers is 'auto' and resolves to 1", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator(0, 1);
    await plugin.install(orch, null, autoWorkerConfig());

    expect(plugin.meterProvider).toBeDefined();
    await plugin.uninstall?.(orch);
  });
});

// Instrumentation ===========================================================

describe("instrumentation", () => {
  it("starts host metrics at count 1 when instrumentation is true", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: true, exportIntervalMs: 1000 });
    const orch = mockOrchestrator(1, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    expect(mockHostMetricsStart).toHaveBeenCalledTimes(1);
    await plugin.uninstall?.(orch);
  });

  it("does not start host metrics when instrumentation is false", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator(1, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    expect(mockHostMetricsStart).not.toHaveBeenCalled();
    await plugin.uninstall?.(orch);
  });
});

// Custom prefix =============================================================

describe("custom prefix", () => {
  it("applies custom prefix to metric names", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, prefix: "myapp.", exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:crash", { workerId: 1, pid: 1, code: 1, signal: null });

    expect(spies["myapp.worker.crashes"]).toHaveBeenCalledTimes(1);
    restore();
    await plugin.uninstall?.(orch);
  });
});

// Exporter headers forwarding ===============================================

describe("exporter headers option", () => {
  it("forwards headers to the http exporter constructor", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({
      instrumentation: false,
      exportIntervalMs: 1000,
      headers: { Authorization: "Bearer test-token" },
    });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    expect(exporterCtorArgs.http).toEqual([
      { url: "http://localhost:4318/v1/metrics", headers: { Authorization: "Bearer test-token" } },
    ]);
    await plugin.uninstall?.(orch);
  });

  it("warns and omits headers for the grpc exporter (unsupported)", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const logger = mockLogger();
    const plugin = createOtlpMeterPlugin({
      instrumentation: false,
      protocol: "grpc",
      exportIntervalMs: 1000,
      headers: { Authorization: "Bearer test-token" },
    });
    const orch = mockOrchestrator();
    await plugin.install(orch, logger, singleWorkerConfig());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("headers are not supported by the gRPC exporter"),
      undefined,
    );
    // The gRPC exporter config has no `headers` support: constructed without them.
    expect(exporterCtorArgs.grpc).toEqual([{ url: "localhost:4317" }]);
    await plugin.uninstall?.(orch);
  });
});

// Dynamic import errors ======================================================

// Simulates what `await import()` of a genuinely missing/broken package surfaces:
// the thrown error carries the module-runner code (e.g. ERR_MODULE_NOT_FOUND).
function codedError(code: string): Error {
  return Object.assign(new Error(`simulated ${code} failure`), { code });
}

// A mocked exporter module whose named export getter throws — the throw happens
// inside createExporter()'s try block, so the classifier observes `err` exactly
// as a real dynamic-import failure would deliver it.
function exporterModuleThatThrows(err: unknown): () => unknown {
  return () => ({
    get OTLPMetricExporter(): never {
      throw err;
    },
  });
}

describe("dynamic import errors", () => {
  it("throws clear error when grpc exporter package is missing", async () => {
    vi.doMock(
      "@opentelemetry/exporter-metrics-otlp-grpc",
      exporterModuleThatThrows(codedError("ERR_MODULE_NOT_FOUND")),
    );
    try {
      const mod = await import("../src/index");
      const plugin = mod.createOtlpMeterPlugin({ protocol: "grpc", instrumentation: false, exportIntervalMs: 1000 });
      const orch = mockOrchestrator();

      await expect(plugin.install(orch, null, singleWorkerConfig())).rejects.toThrow(
        /requires @opentelemetry\/exporter-metrics-otlp-grpc/,
      );
    } finally {
      vi.doUnmock("@opentelemetry/exporter-metrics-otlp-grpc");
    }
  });
});

// Missing-module error classification ========================================
// isMissingModuleError drives the "install the module" UX: module-runner codes
// must map to the friendly error, while unrelated filesystem/network failures
// (ENOENT/EACCES/ENOTFOUND) and non-Error values must propagate untouched.

describe("missing-module error classification", () => {
  async function rejectsAsMissingModule(err: unknown): Promise<void> {
    vi.doMock("@opentelemetry/exporter-metrics-otlp-grpc", exporterModuleThatThrows(err));
    try {
      const { createOtlpMeterPlugin } = await import("../src/index");
      const plugin = createOtlpMeterPlugin({ protocol: "grpc", instrumentation: false, exportIntervalMs: 1000 });
      await expect(plugin.install(mockOrchestrator(), null, singleWorkerConfig())).rejects.toThrow(
        /requires @opentelemetry\/exporter-metrics-otlp-grpc/,
      );
    } finally {
      vi.doUnmock("@opentelemetry/exporter-metrics-otlp-grpc");
    }
  }

  async function rejectsWithOriginalError(err: unknown, match: Record<string, unknown>): Promise<void> {
    vi.doMock("@opentelemetry/exporter-metrics-otlp-grpc", exporterModuleThatThrows(err));
    try {
      const { createOtlpMeterPlugin } = await import("../src/index");
      const plugin = createOtlpMeterPlugin({ protocol: "grpc", instrumentation: false, exportIntervalMs: 1000 });
      await expect(plugin.install(mockOrchestrator(), null, singleWorkerConfig())).rejects.toMatchObject(match);
    } finally {
      vi.doUnmock("@opentelemetry/exporter-metrics-otlp-grpc");
    }
  }

  it("treats MODULE_NOT_FOUND-coded failures as a missing module", async () => {
    await rejectsAsMissingModule(codedError("MODULE_NOT_FOUND"));
  });

  it("does not treat ENOENT-coded failures as a missing module", async () => {
    await rejectsWithOriginalError(codedError("ENOENT"), { code: "ENOENT" });
  });

  it("does not treat EACCES-coded failures as a missing module", async () => {
    await rejectsWithOriginalError(codedError("EACCES"), { code: "EACCES" });
  });

  it("does not treat ENOTFOUND-coded failures as a missing module", async () => {
    await rejectsWithOriginalError(codedError("ENOTFOUND"), { code: "ENOTFOUND" });
  });

  it("propagates thrown undefined untouched", async () => {
    vi.doMock("@opentelemetry/exporter-metrics-otlp-grpc", exporterModuleThatThrows(undefined));
    try {
      const { createOtlpMeterPlugin } = await import("../src/index");
      const plugin = createOtlpMeterPlugin({ protocol: "grpc", instrumentation: false, exportIntervalMs: 1000 });
      await expect(plugin.install(mockOrchestrator(), null, singleWorkerConfig())).rejects.toBeUndefined();
    } finally {
      vi.doUnmock("@opentelemetry/exporter-metrics-otlp-grpc");
    }
  });

  it("propagates thrown plain objects untouched", async () => {
    const thrown: Record<string, never> = {};
    vi.doMock("@opentelemetry/exporter-metrics-otlp-grpc", exporterModuleThatThrows(thrown));
    try {
      const { createOtlpMeterPlugin } = await import("../src/index");
      const plugin = createOtlpMeterPlugin({ protocol: "grpc", instrumentation: false, exportIntervalMs: 1000 });
      await expect(plugin.install(mockOrchestrator(), null, singleWorkerConfig())).rejects.toBe(thrown);
    } finally {
      vi.doUnmock("@opentelemetry/exporter-metrics-otlp-grpc");
    }
  });
});

// Meter version constant =====================================================

describe("meter version constant", () => {
  it("registers the meter with the version declared in package.json", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const sdkMod = await import("@opentelemetry/sdk-metrics");
    const MeterProvider = sdkMod.MeterProvider as typeof MeterProviderType;
    const origGetMeter = MeterProvider.prototype.getMeter;
    const getMeterCalls: Array<[string, string | undefined]> = [];
    MeterProvider.prototype.getMeter = function (this: MeterProvider, ...args: Parameters<typeof origGetMeter>) {
      getMeterCalls.push([args[0], args[1]]);
      return origGetMeter.apply(this, args);
    } as typeof origGetMeter;

    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    try {
      await plugin.install(orch, null, singleWorkerConfig());

      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(getMeterCalls).toContainEqual(["@goopil/clusterkit", pkg.version]);
    } finally {
      MeterProvider.prototype.getMeter = origGetMeter;
      await plugin.uninstall?.(orch);
    }
  });
});

// Global meter provider preservation =========================================
// The app may configure its own OTel SDK before `run()` — the plugin must not
// clobber it.

describe("global meter provider preservation", () => {
  let logger: LoggerSpy;

  beforeEach(async () => {
    const { metrics } = await import("@opentelemetry/api");
    metrics.disable(); // clear any global provider left over from other tests
    logger = mockLogger();
  });

  afterEach(async () => {
    const { metrics } = await import("@opentelemetry/api");
    metrics.disable();
  });

  it("does not replace an already-registered global meter provider and warns", async () => {
    const { metrics } = await import("@opentelemetry/api");
    const { MeterProvider } = await import("@opentelemetry/sdk-metrics");
    const appProvider = new MeterProvider(); // the app's own OTel setup
    expect(metrics.setGlobalMeterProvider(appProvider)).toBe(true);

    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, logger, singleWorkerConfig());

    expect(metrics.getMeterProvider()).toBe(appProvider);
    expect(logger.warn).toHaveBeenCalled();
    await plugin.uninstall?.(orch);
  });

  it("registers its own provider globally when no global provider exists", async () => {
    const { metrics } = await import("@opentelemetry/api");
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, logger, singleWorkerConfig());

    expect(metrics.getMeterProvider()).toBe(plugin.meterProvider);
    expect(logger.warn).not.toHaveBeenCalled();
    await plugin.uninstall?.(orch);
  });

  it("releases the global registration on uninstall so app code no longer hits the shut-down provider", async () => {
    const { metrics } = await import("@opentelemetry/api");
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, logger, singleWorkerConfig());
    expect(metrics.getMeterProvider()).toBe(plugin.meterProvider);

    await plugin.uninstall?.(orch);

    // The global no longer points at the (now shut-down) plugin provider…
    expect(metrics.getMeterProvider()).not.toBe(plugin.meterProvider);
    // …a fresh meter from app code is still usable…
    expect(() => metrics.getMeter("app-check").createCounter("app.checks")).not.toThrow();
    // …and the global slot is genuinely free: the app can register its own provider again.
    const { MeterProvider } = await import("@opentelemetry/sdk-metrics");
    expect(metrics.setGlobalMeterProvider(new MeterProvider())).toBe(true);
  });

  it("leaves a pre-existing global provider registered after uninstall", async () => {
    const { metrics } = await import("@opentelemetry/api");
    const { MeterProvider } = await import("@opentelemetry/sdk-metrics");
    const appProvider = new MeterProvider();
    expect(metrics.setGlobalMeterProvider(appProvider)).toBe(true);

    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, logger, singleWorkerConfig());
    expect(metrics.getMeterProvider()).toBe(appProvider);

    await plugin.uninstall?.(orch);

    expect(metrics.getMeterProvider()).toBe(appProvider);
  });
});
