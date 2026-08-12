import { EventEmitter } from "node:events";
import type { Logger, Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
import { describe, expect, it, vi } from "vitest";

// Mock the OTLP exporter so install() doesn't try to reach a real collector
vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: class {
    async export(_metrics: unknown, cb: (r: { status: number }) => void) {
      cb({ status: 0 });
    }
    async shutdown() {}
    async forceFlush() {}
  },
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-grpc", () => ({
  OTLPMetricExporter: class {
    async export(_metrics: unknown, cb: (r: { status: number }) => void) {
      cb({ status: 0 });
    }
    async shutdown() {}
    async forceFlush() {}
  },
}));

vi.mock("@opentelemetry/host-metrics", () => ({
  HostMetrics: class {
    start() {}
  },
}));

// Helpers (reused by later tasks) ===========================================

function mockOrchestrator(activeWorkers = 0, workerCount = 0): Orchestrator {
  const emitter = new EventEmitter() as EventEmitter & {
    currentActiveWorkers: number;
    getMetrics: () => { activeWorkers: number };
    workerCount: number;
    registerOnShutdown: (cb: () => void | Promise<void>) => void;
  };
  emitter.currentActiveWorkers = activeWorkers;
  emitter.getMetrics = () => ({ activeWorkers: emitter.currentActiveWorkers });
  emitter.workerCount = workerCount;
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

// Counter spy helper: intercepts createCounter to capture add() calls
function spyOnCounters(): {
  spies: Record<string, ReturnType<typeof vi.fn>>;
  restore: () => void;
} {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  const { MeterProvider } = require("@opentelemetry/sdk-metrics") as {
    MeterProvider: { prototype: { getMeter: (...a: unknown[]) => unknown } };
  };
  const origGetMeter = MeterProvider.prototype.getMeter;
  MeterProvider.prototype.getMeter = vi.fn(function (this: unknown, ...args: unknown[]) {
    // @ts-expect-error - patching for test
    const meter = origGetMeter.apply(this, args);
    const origCreateCounter = meter.createCounter.bind(meter);
    meter.createCounter = vi.fn((name: string) => {
      const counter = origCreateCounter(name);
      spies[name] = vi.spyOn(counter, "add");
      return counter;
    });
    return meter;
  }) as unknown as typeof origGetMeter;
  return {
    spies,
    restore: () => {
      MeterProvider.prototype.getMeter = origGetMeter;
    },
  };
}

// Interface conformance =====================================================

describe("OtlpMeterPlugin interface", () => {
  it("has the required OrchestratorPlugin fields", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false });
    expect(plugin.name).toBe("otlp-meter");
    expect(typeof plugin.install).toBe("function");
    expect(typeof plugin.uninstall).toBe("function");
    expect(typeof plugin.shutdown).toBe("function");
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
});

// Event → counter mapping ===================================================

describe("metrics — event to counter mapping", () => {
  it("worker:crash increments worker.crashes counter", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 100 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:crash", { workerId: 1, pid: 1234, code: 1, signal: null });

    expect(spies["clusterkit.worker.crashes"]).toHaveBeenCalledTimes(1);
    expect(spies["clusterkit.worker.crashes"]).toHaveBeenCalledWith(1);
    restore();
    await plugin.shutdown();
  });

  it("worker:restart increments worker.restarts counter", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 100 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:restart", { newWorkerId: 2, newPid: 5678 });

    expect(spies["clusterkit.worker.restarts"]).toHaveBeenCalledTimes(1);
    expect(spies["clusterkit.worker.restarts"]).toHaveBeenCalledWith(1);
    restore();
    await plugin.shutdown();
  });

  it("circuit-breaker:tripped increments circuit_breaker.trips counter", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 100 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "circuit-breaker:tripped", { crashCount: 5, windowMs: 60000 });

    expect(spies["clusterkit.circuit_breaker.trips"]).toHaveBeenCalledTimes(1);
    expect(spies["clusterkit.circuit_breaker.trips"]).toHaveBeenCalledWith(1);
    restore();
    await plugin.shutdown();
  });

  it("counters accumulate across multiple events", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 100 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:restart", { newWorkerId: 2, newPid: 2 });
    emit(orch, "worker:restart", { newWorkerId: 3, newPid: 3 });
    emit(orch, "worker:restart", { newWorkerId: 4, newPid: 4 });

    expect(spies["clusterkit.worker.restarts"]).toHaveBeenCalledTimes(3);
    restore();
    await plugin.shutdown();
  });

  it("does not duplicate event listeners after uninstall and reinstall", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 100 });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, singleWorkerConfig());
    emit(orch, "worker:restart", { newWorkerId: 1, newPid: 1 });

    await plugin.uninstall?.(orch);
    await plugin.install(orch, null, singleWorkerConfig());
    emit(orch, "worker:restart", { newWorkerId: 2, newPid: 2 });

    expect(spies["clusterkit.worker.restarts"]).toHaveBeenCalledTimes(1);
    restore();
    await plugin.shutdown();
  });
});

// Plugin lifecycle logging ===================================================

describe("plugin lifecycle", () => {
  it("prefixes install logs with the plugin component tag", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const logger = mockLogger();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 100 });
    const orch = mockOrchestrator();
    await plugin.install(orch, logger, singleWorkerConfig());

    expect(logger.debug).toHaveBeenCalledWith("[clusterkit:otlp-meter] Plugin installed on primary process");
    await plugin.shutdown();
  });

  it("clears listeners on uninstall", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 100 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    expect((orch as unknown as EventEmitter).listenerCount("worker:crash")).toBe(1);

    await plugin.uninstall?.(orch);

    expect((orch as unknown as EventEmitter).listenerCount("worker:crash")).toBe(0);
    await plugin.shutdown();
  });
});

// Single-worker mode =========================================================

describe("single-worker mode", () => {
  it("creates meter provider when workerCount is 1", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 100 });
    const orch = mockOrchestrator(0, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    expect(plugin.meterProvider).toBeDefined();
    await plugin.shutdown();
  });

  it("creates meter provider when workers is 'auto' and resolves to 1", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 100 });
    const orch = mockOrchestrator(0, 1);
    await plugin.install(orch, null, autoWorkerConfig());

    expect(plugin.meterProvider).toBeDefined();
    await plugin.shutdown();
  });
});

// Custom prefix ==============================================================

describe("custom prefix", () => {
  it("applies custom prefix to metric names", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, prefix: "myapp.", exportIntervalMs: 100 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:crash", { workerId: 1, pid: 1, code: 1, signal: null });

    expect(spies["myapp.worker.crashes"]).toHaveBeenCalledTimes(1);
    restore();
    await plugin.shutdown();
  });
});

// Dynamic import errors ======================================================

describe("dynamic import errors", () => {
  it("throws clear error when grpc exporter package is missing", async () => {
    vi.doMock("@opentelemetry/exporter-metrics-otlp-grpc", () => {
      throw new Error("Module not found");
    });

    const mod = await import("../src/index");
    const plugin = mod.createOtlpMeterPlugin({ protocol: "grpc", instrumentation: false, exportIntervalMs: 100 });
    const orch = mockOrchestrator();

    await expect(plugin.install(orch, null, singleWorkerConfig())).rejects.toThrow(
      /requires @opentelemetry\/exporter-metrics-otlp-grpc/,
    );

    vi.doUnmock("@opentelemetry/exporter-metrics-otlp-grpc");
  });
});
