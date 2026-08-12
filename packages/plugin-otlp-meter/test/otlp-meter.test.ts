import { EventEmitter } from "node:events";
import type { Logger, Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
import { describe, expect, it, vi } from "vitest";

// Helpers (reused by later tasks) ===========================================

/** Cast a plain EventEmitter to Orchestrator for testing. */
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

/** Emit a typed event on the mock orchestrator. */
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
