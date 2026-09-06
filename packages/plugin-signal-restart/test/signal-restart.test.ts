import cluster from "node:cluster";
import { EventEmitter } from "node:events";
import type { Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalRestartPlugin } from "../src/index";

vi.mock("node:cluster", () => ({ default: { isPrimary: true } }));

function mockOrchestrator(workerCount = 2): Orchestrator {
  const emitter = new EventEmitter() as EventEmitter & {
    workerCount: number;
    restartWorkers: ReturnType<typeof vi.fn>;
  };
  emitter.workerCount = workerCount;
  emitter.restartWorkers = vi.fn().mockResolvedValue(undefined);
  return emitter as unknown as Orchestrator;
}

function mockConfig(count: number | "auto" = 2): ResolvedConfig {
  return {
    logger: null,
    workers: { count, env: undefined, execArgv: undefined, maxAgeMs: 0 },
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

describe("signal-restart plugin", () => {
  let handlers: Array<{ signal: string; handler: (...args: unknown[]) => void }>;

  beforeEach(() => {
    handlers = [];
    vi.spyOn(process, "on").mockImplementation((signal: string, handler: (...args: unknown[]) => void) => {
      handlers.push({ signal, handler });
      return process;
    });
    vi.spyOn(process, "off").mockImplementation((signal: string, handler: (...args: unknown[]) => void) => {
      handlers = handlers.filter((h) => !(h.signal === signal && h.handler === handler));
      return process;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a SIGHUP listener by default", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig());

    expect(handlers.some((h) => h.signal === "SIGHUP")).toBe(true);
  });

  it("registers a custom signal when configured", async () => {
    const plugin = createSignalRestartPlugin({ signal: "SIGUSR2" });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig());

    expect(handlers.some((h) => h.signal === "SIGUSR2")).toBe(true);
    expect(handlers.some((h) => h.signal === "SIGHUP")).toBe(false);
  });

  it("calls restartWorkers on signal in multi-worker mode", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();
    const restartWorkers = (orch as unknown as { restartWorkers: ReturnType<typeof vi.fn> }).restartWorkers;

    await plugin.install(orch, null, mockConfig(3));

    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(restartWorkers).toHaveBeenCalledWith({ staggerMs: 1000, reason: "signal:SIGHUP" });
    expect(plugin.lastRestart).toBeInstanceOf(Date);
  });

  it("rolls the single worker via restartWorkers at count 1", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator(1);
    const restartWorkers = (orch as unknown as { restartWorkers: ReturnType<typeof vi.fn> }).restartWorkers;

    await plugin.install(orch, null, mockConfig(1));

    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(restartWorkers).toHaveBeenCalledWith({ staggerMs: 1000, reason: "signal:SIGHUP" });
    await plugin.uninstall?.(orch);
  });

  it("rolls the single worker when workers is 'auto' and resolves to 1", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator(1);
    const restartWorkers = (orch as unknown as { restartWorkers: ReturnType<typeof vi.fn> }).restartWorkers;

    await plugin.install(orch, null, mockConfig("auto"));

    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(restartWorkers).toHaveBeenCalledOnce();
    await plugin.uninstall?.(orch);
  });

  it("does not register listener in worker process", async () => {
    Object.defineProperty(cluster, "isPrimary", { value: false, configurable: true });
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig());

    expect(handlers).toHaveLength(0);
    Object.defineProperty(cluster, "isPrimary", { value: true, configurable: true });
  });

  it("removes the listener on uninstall", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig());
    expect(handlers).toHaveLength(1);

    await plugin.uninstall?.(orch);
    expect(handlers).toHaveLength(0);
  });

  it("passes custom staggerMs and reason to restartWorkers", async () => {
    const plugin = createSignalRestartPlugin({ staggerMs: 500, reason: "custom" });
    const orch = mockOrchestrator();
    const restartWorkers = (orch as unknown as { restartWorkers: ReturnType<typeof vi.fn> }).restartWorkers;

    await plugin.install(orch, null, mockConfig(3));

    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(restartWorkers).toHaveBeenCalledWith({ staggerMs: 500, reason: "custom" });
  });

  it("logs error when restartWorkers rejects with Error", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();
    (orch as any).restartWorkers.mockRejectedValueOnce(new Error("boom"));

    await plugin.install(orch, null, mockConfig(3));
    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(plugin.lastRestart).toBeUndefined();
  });

  it("logs error when restartWorkers rejects with non-Error", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();
    (orch as any).restartWorkers.mockRejectedValueOnce("string error");

    await plugin.install(orch, null, mockConfig(3));
    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(plugin.lastRestart).toBeUndefined();
  });

  it("does not remove listener on uninstall when not in primary", async () => {
    Object.defineProperty(cluster, "isPrimary", { value: false, configurable: true });
    const plugin = createSignalRestartPlugin();
    await plugin.install(mockOrchestrator(), null, mockConfig(2));
    await plugin.uninstall?.();
    Object.defineProperty(cluster, "isPrimary", { value: true, configurable: true });
    expect(process.off).not.toHaveBeenCalled();
  });

  describe("install warnings", () => {
    function mockLogger() {
      return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
    }

    function withTTY<T>(fn: () => T): T {
      const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      try {
        return fn();
      } finally {
        if (original) Object.defineProperty(process.stdout, "isTTY", original);
        else delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
    }

    it("warns when signal is SIGTERM (reserved for orchestrator shutdown)", async () => {
      const plugin = createSignalRestartPlugin({ signal: "SIGTERM" });
      const logger = mockLogger();

      await plugin.install(mockOrchestrator(), logger, mockConfig());

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [msg] = logger.warn.mock.calls[0] as [string];
      expect(msg).toContain("SIGTERM");
      expect(msg).toContain("SIGUSR2");
    });

    it("warns when signal is SIGINT (reserved for orchestrator shutdown)", async () => {
      const plugin = createSignalRestartPlugin({ signal: "SIGINT" });
      const logger = mockLogger();

      await plugin.install(mockOrchestrator(), logger, mockConfig());

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [msg] = logger.warn.mock.calls[0] as [string];
      expect(msg).toContain("SIGINT");
    });

    it("warns when default SIGHUP is used on a TTY (terminal hangup)", async () => {
      const plugin = createSignalRestartPlugin();
      const logger = mockLogger();

      withTTY(async () => {
        await plugin.install(mockOrchestrator(), logger, mockConfig());
      });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [msg] = logger.warn.mock.calls[0] as [string];
      expect(msg).toContain("SIGHUP");
      expect(msg).toContain("SIGUSR2");
      expect(handlers.some((h) => h.signal === "SIGHUP")).toBe(true);
    });

    it("does not warn on default SIGHUP when stdout is not a TTY", async () => {
      const plugin = createSignalRestartPlugin();
      const logger = mockLogger();

      await plugin.install(mockOrchestrator(), logger, mockConfig());

      expect(logger.warn).not.toHaveBeenCalled();
      expect(handlers.some((h) => h.signal === "SIGHUP")).toBe(true);
    });

    it("does not warn for non-reserved custom signal", async () => {
      const plugin = createSignalRestartPlugin({ signal: "SIGUSR2" });
      const logger = mockLogger();

      await plugin.install(mockOrchestrator(), logger, mockConfig());

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
