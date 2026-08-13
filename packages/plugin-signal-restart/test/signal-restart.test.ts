import cluster from "node:cluster";
import { EventEmitter } from "node:events";
import type { Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalRestartPlugin } from "../src/index";

vi.mock("node:cluster", () => ({ default: { isPrimary: true } }));

function mockOrchestrator(): Orchestrator {
  const emitter = new EventEmitter() as Orchestrator & {
    restartWorkers: ReturnType<typeof vi.fn>;
  };
  (emitter as unknown as { restartWorkers: ReturnType<typeof vi.fn> }).restartWorkers = vi
    .fn()
    .mockResolvedValue(undefined);
  return emitter;
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

  it("sends SIGTERM to self in single-worker mode", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    await plugin.install(orch, null, mockConfig(1));

    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    killSpy.mockRestore();
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
});
