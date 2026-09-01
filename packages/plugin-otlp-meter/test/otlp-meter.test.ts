import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { Logger, Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
import type { MeterProvider as MeterProviderType } from "@opentelemetry/sdk-metrics";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHostMetricsStart = vi.fn();

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
    start() {
      mockHostMetricsStart();
    }
  },
}));

beforeEach(() => {
  mockHostMetricsStart.mockClear();
});

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
    await plugin.shutdown();
  });

  it("accepts exportIntervalMs above the floor (1500)", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ exportIntervalMs: 1500, instrumentation: false });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    expect(plugin.meterProvider).toBeDefined();
    await plugin.shutdown();
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
    await plugin.shutdown();
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
    await plugin.shutdown();
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
    await plugin.shutdown();
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
    await plugin.shutdown();
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
    await plugin.shutdown();
  });
});

// Double shutdown guard =====================================================

describe("shutdown safety", () => {
  it("does not throw when shutdown() is called twice", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    await plugin.shutdown();
    await expect(plugin.shutdown()).resolves.not.toThrow();
  });

  it("does not throw when shutdown callback and shutdown() both fire", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    let shutdownCb: (() => void | Promise<void>) | undefined;
    const orch = mockOrchestrator();
    (orch as unknown as { registerOnShutdown: (cb: typeof shutdownCb) => void }).registerOnShutdown = (cb) => {
      shutdownCb = cb;
    };
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    await plugin.install(orch, null, singleWorkerConfig());

    await shutdownCb?.();
    await expect(plugin.shutdown()).resolves.not.toThrow();
  });

  it("resets the shutdown latch on reinstall so the new provider can be shut down", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, singleWorkerConfig());
    const first = plugin.meterProvider;
    await plugin.shutdown();
    expect(plugin.meterProvider).toBeUndefined();

    // Reinstall the same instance after shutdown: the new provider must be usable
    await plugin.install(orch, null, singleWorkerConfig());
    const second = plugin.meterProvider;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    // The latch was reset: shutdown() must actually shut down the new provider
    await plugin.shutdown();
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
    await plugin.shutdown();
  });

  it("clears listeners on uninstall", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    expect((orch as unknown as EventEmitter).listenerCount("worker:crash")).toBe(1);

    await plugin.uninstall?.(orch);

    expect((orch as unknown as EventEmitter).listenerCount("worker:crash")).toBe(0);
    await plugin.shutdown();
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

// Single-worker mode =========================================================

describe("single-worker mode", () => {
  it("creates meter provider when workerCount is 1", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator(0, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    expect(plugin.meterProvider).toBeDefined();
    await plugin.shutdown();
  });

  it("creates meter provider when workers is 'auto' and resolves to 1", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator(0, 1);
    await plugin.install(orch, null, autoWorkerConfig());

    expect(plugin.meterProvider).toBeDefined();
    await plugin.shutdown();
  });
});

// Instrumentation ===========================================================

describe("instrumentation", () => {
  it("starts host metrics in single-worker mode when instrumentation is true", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: true, exportIntervalMs: 1000 });
    const orch = mockOrchestrator(1, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    expect(mockHostMetricsStart).toHaveBeenCalledTimes(1);
    await plugin.shutdown();
  });

  it("does not start host metrics when instrumentation is false", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator(1, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    expect(mockHostMetricsStart).not.toHaveBeenCalled();
    await plugin.shutdown();
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
    await plugin.shutdown();
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
      await plugin.shutdown();
    }
  });
});
