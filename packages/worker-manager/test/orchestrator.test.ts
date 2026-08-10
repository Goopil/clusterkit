import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../src/orchestrator";

// ============================================================================
// Mock cluster helpers
// ============================================================================

class MockWorker extends EventEmitter {
  id: number;
  process: { pid: number; kill: ReturnType<typeof vi.fn> };
  exitedAfterDisconnect = false;
  autoExitOnDisconnect = false;
  private _isDead = false;
  private _isConnected = true;

  constructor(id: number) {
    super();
    this.id = id;
    this.process = { pid: 1000 + id, kill: vi.fn() };
  }

  isDead() {
    return this._isDead;
  }
  isConnected() {
    return this._isConnected;
  }

  disconnect() {
    this._isConnected = false;
    this.exitedAfterDisconnect = true;
    this.emit("disconnect");
    if (this.autoExitOnDisconnect) {
      this._isDead = true;
      this.emit("exit", 0, null);
    }
  }

  send(_msg: unknown) {
    if (!this._isConnected) throw new Error("Worker not connected");
    return true;
  }

  /** Simulate an unclean crash. */
  simulateCrash(code: number | null = 1, signal: string | null = null) {
    this._isDead = true;
    this._isConnected = false;
    this.emit("exit", code, signal);
  }

  simulateGracefulExit(code: number | null = 0, signal: string | null = null) {
    this.exitedAfterDisconnect = true;
    this._isDead = true;
    this._isConnected = false;
    this.emit("exit", code, signal);
  }
}

class MockCluster extends EventEmitter {
  isPrimary = true;
  workers: Record<number, MockWorker> = {};
  settings: Record<string, unknown> = {};
  private counter = 1;
  setupPrimary = vi.fn((options: Record<string, unknown>) => {
    this.settings = { ...this.settings, ...options };
  });

  fork(_env?: NodeJS.ProcessEnv): MockWorker {
    const worker = new MockWorker(this.counter++);
    this.workers[worker.id] = worker;
    // Emit online asynchronously on both cluster and worker (matches real
    // Node.js cluster behaviour where both the cluster and the Worker emit).
    setImmediate(() => {
      this.emit("online", worker);
      worker.emit("online");
    });
    return worker;
  }

  reset() {
    this.workers = {};
    this.counter = 1;
    this.removeAllListeners();
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Returns a base config that injects the mock cluster. */
type TestConfig = Omit<Partial<Parameters<typeof Orchestrator>[0]>, "workers"> & {
  workers?: number | "auto" | Parameters<typeof Orchestrator>[0]["workers"];
};

function cfg(extra: TestConfig = {}): Parameters<typeof Orchestrator>[0] {
  const { workers, ...rest } = extra;

  const workersConfig = typeof workers === "number" || workers === "auto" ? { count: workers } : workers;

  return {
    ...rest,
    clusterModule: mockCluster as any,
    ...(workersConfig !== undefined ? { workers: workersConfig } : {}),
  };
}

let mockCluster: MockCluster;

beforeEach(() => {
  mockCluster = new MockCluster();
  // Prevent MaxListenersExceededWarning across all tests in this file
  process.setMaxListeners(100);
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockCluster.reset();
});

// ============================================================================
// Tests
// ============================================================================

describe("Orchestrator", () => {
  // --------------------------------------------------------------------------
  describe("constructor", () => {
    it("should create an instance with no config", () => {
      expect(new Orchestrator(cfg())).toBeInstanceOf(Orchestrator);
    });

    it("should accept all valid grouped config options", () => {
      expect(
        () =>
          new Orchestrator(
            cfg({
              shutdown: {
                timeoutMs: 10_000,
                messagePrefix: "app",
                sigtermDelayMs: 1_000,
                sigintDelayMs: 500,
              },
              restart: {
                crashThreshold: 3,
                crashWindowMs: 30_000,
              },
              workers: {
                count: 2,
                maxAgeMs: 0,
                env: { NODE_ENV: "test" },
                execArgv: ["--max-old-space-size=512"],
              },
            }),
          ),
      ).not.toThrow();
    });

    it("should reject invalid workers value", () => {
      expect(() => new Orchestrator(cfg({ workers: 0 }))).toThrow();
    });

    it("should reject invalid shutdown.timeoutMs", () => {
      expect(() => new Orchestrator(cfg({ shutdown: { timeoutMs: -1 } }))).toThrow();
    });

    it("should reject invalid shutdown.messagePrefix", () => {
      expect(() => new Orchestrator(cfg({ shutdown: { messagePrefix: "" } }))).toThrow();
      expect(() => new Orchestrator(cfg({ shutdown: { messagePrefix: "a:b" } }))).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  describe("construction API", () => {
    it("should use constructor as the explicit creation path", () => {
      const orch = new Orchestrator(cfg());
      expect(orch).toBeInstanceOf(Orchestrator);
      expect((Orchestrator as unknown as { create?: unknown }).create).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  describe("static supportsReusePort", () => {
    it("should return a boolean", async () => {
      expect(typeof (await Orchestrator.supportsReusePort())).toBe("boolean");
    });
  });

  // --------------------------------------------------------------------------
  describe("static getCapabilities", () => {
    it("should return platform capabilities with required fields", async () => {
      const caps = await Orchestrator.getCapabilities();
      expect(caps).toHaveProperty("platform");
      expect(caps).toHaveProperty("reusePort");
      expect(caps).toHaveProperty("clusterRecommended");
    });
  });

  // --------------------------------------------------------------------------
  describe("getMetrics", () => {
    it("should return zeroed metrics before any activity", () => {
      const m = new Orchestrator(cfg()).getMetrics();
      expect(m).toEqual({
        workerRestarts: 0,
        activeWorkers: 0,
        crashLoopBackoffs: 0,
        gracefulShutdowns: 0,
        forcedKills: 0,
      });
    });

    it("should return a snapshot (not a live reference)", () => {
      const orch = new Orchestrator(cfg());
      const m1 = orch.getMetrics();
      const m2 = orch.getMetrics();
      expect(m1).not.toBe(m2); // different object references
      expect(m1).toEqual(m2);
    });
  });

  // --------------------------------------------------------------------------
  describe("getHealth", () => {
    it("should return { ready, live }", () => {
      const health = new Orchestrator(cfg()).getHealth();
      expect(health).toHaveProperty("ready", true);
      expect(health).toHaveProperty("live", true);
    });
  });

  // --------------------------------------------------------------------------
  describe("setNotReady", () => {
    it("should set ready to false", () => {
      const orch = new Orchestrator(cfg());
      orch.setNotReady();
      expect(orch.getHealth().ready).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  describe("registerOnShutdown", () => {
    it("should accept a callback without throwing", () => {
      const orch = new Orchestrator(cfg());
      expect(() => orch.registerOnShutdown(async () => {})).not.toThrow();
    });

    it("should accept a synchronous callback without throwing", () => {
      const orch = new Orchestrator(cfg());
      expect(() => orch.registerOnShutdown((() => undefined) as () => Promise<void>)).not.toThrow();
    });

    it("should allow overwriting the callback", () => {
      const orch = new Orchestrator(cfg());
      orch.registerOnShutdown(async () => {});
      expect(() => orch.registerOnShutdown(async () => {})).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  describe("overrideWorkerCount", () => {
    it("should reject non-positive values", () => {
      const orch = new Orchestrator(cfg());
      expect(() => orch.overrideWorkerCount(0)).toThrow();
      expect(() => orch.overrideWorkerCount(-1)).toThrow();
    });

    it("should reject non-integer values", () => {
      const orch = new Orchestrator(cfg());
      expect(() => orch.overrideWorkerCount(2.5)).toThrow();
    });

    it("should reject overriding an explicit worker count", () => {
      const orch = new Orchestrator(cfg({ workers: 2 }));
      expect(() => orch.overrideWorkerCount(3)).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  describe("run() — primary mode (isPrimary = true, workers > 1)", () => {
    it("should fork the requested number of workers", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 3 }));
      await orch.run(() => {});
      expect(Object.keys(mockCluster.workers).length).toBe(3);
    });

    it("should track activeWorkers", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      await orch.run(() => {});
      expect(orch.getMetrics().activeWorkers).toBe(2);
    });

    it("should emit worker:online after each fork", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      const events: unknown[] = [];
      orch.on("worker:online", (data) => events.push(data));
      await orch.run(() => {});
      // Let setImmediate callbacks fire
      await new Promise<void>((r) => setImmediate(r));
      expect(events.length).toBe(2);
    });

    it("should throw if called a second time on the same instance", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      await orch.run(() => {});
      await expect(orch.run(() => {})).rejects.toThrow("already called");
    });
  });

  // --------------------------------------------------------------------------
  describe("run() — worker mode (isPrimary = false)", () => {
    it("should call the start function", async () => {
      mockCluster.isPrimary = false;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      const start = vi.fn().mockResolvedValue(undefined);
      await orch.run(start);
      expect(start).toHaveBeenCalledOnce();
    });

    it("should not fork any workers", async () => {
      mockCluster.isPrimary = false;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      await orch.run(() => {});
      expect(Object.keys(mockCluster.workers).length).toBe(0);
    });

    it("should throw if called a second time on the same worker instance", async () => {
      mockCluster.isPrimary = false;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      await orch.run(() => {});
      await expect(orch.run(() => {})).rejects.toThrow("already called");
    });

    it("should run worker shutdown callbacks only once when signal and IPC overlap", async () => {
      mockCluster.isPrimary = false;

      // Capture the IPC "message" listener instead of registering it: vitest
      // itself communicates with its parent over process IPC, so emitting a
      // real "message" event would corrupt the test runner channel.
      const capturedMessageListeners: Array<(msg: unknown) => void> = [];
      const originalOn = process.on.bind(process);
      const onSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: (msg: unknown) => void) => {
        if (event === "message") {
          capturedMessageListeners.push(listener);
          return process;
        }
        return originalOn(event as NodeJS.Signals, listener);
      }) as typeof process.on);
      const sendSpy = process.send ? vi.spyOn(process, "send").mockReturnValue(true) : undefined;

      const orch = new Orchestrator(cfg({ workers: 2 }));
      const onShutdown = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      await orch.run(() => {
        orch.registerOnShutdown(onShutdown);
      });
      onSpy.mockRestore();

      process.emit("SIGINT", "SIGINT");
      for (const listener of capturedMessageListeners) {
        listener({ type: "__wm:shutdown" });
      }

      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(onShutdown).toHaveBeenCalledTimes(1);
      sendSpy?.mockRestore();
    });

    it("should force exit with code 1 when shutdown callbacks exceed timeout", async () => {
      vi.useFakeTimers();
      mockCluster.isPrimary = false;

      const orch = new Orchestrator(
        cfg({
          workers: 2,
          shutdown: {
            timeoutMs: 4_000,
            ackTimeoutMs: 1_000,
          },
        }),
      );

      await orch.run(() => {
        orch.registerOnShutdown(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
        });
      });

      const exitSpy = vi.mocked(process.exit);
      process.emit("SIGTERM", "SIGTERM");

      await vi.advanceTimersByTimeAsync(4_000);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // --------------------------------------------------------------------------
  describe("run() — single-worker mode (workers = 1)", () => {
    it("should call the start function directly without forking", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 1 }));
      const start = vi.fn().mockResolvedValue(undefined);
      await orch.run(start);
      expect(start).toHaveBeenCalledOnce();
      expect(Object.keys(mockCluster.workers).length).toBe(0);
    });

    it("should run shutdown callbacks and emit shutdown events on SIGTERM", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 1 }));
      const onShutdown = vi.fn();
      await orch.run(() => {
        orch.registerOnShutdown(onShutdown);
      });

      const events: unknown[] = [];
      orch.on("shutdown:start", (d) => events.push(d));

      process.emit("SIGTERM", "SIGTERM");
      await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledWith("SIGTERM"));

      expect(events).toEqual([{ signal: "SIGTERM" }]);
      expect(orch.getHealth().ready).toBe(false);
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    });

    it("should uninstall plugins on single-worker shutdown", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 1 }));
      const uninstall = vi.fn();
      orch.use({ name: "p", install: vi.fn(), uninstall });
      await orch.run(() => {});

      process.emit("SIGINT", "SIGINT");
      await vi.waitFor(() => expect(uninstall).toHaveBeenCalledOnce());
    });

    it("should run the shutdown sequence only once for overlapping signals", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 1 }));
      const onShutdown = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      await orch.run(() => {
        orch.registerOnShutdown(onShutdown);
      });

      process.emit("SIGTERM", "SIGTERM");
      process.emit("SIGINT", "SIGINT");
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(onShutdown).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  describe("plugin-driven configuration (install before fork)", () => {
    it("overrideWorkerCount() from a plugin install() controls the initial fork count", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: "auto" }));
      orch.use({
        name: "sizing",
        install: (o) => {
          o.overrideWorkerCount(3);
        },
      });
      await orch.run(() => {});
      expect(Object.keys(mockCluster.workers).length).toBe(3);
    });

    it("patchWorkerEnv() from a plugin install() applies to the initial fleet", async () => {
      mockCluster.isPrimary = true;
      const forkSpy = vi.spyOn(mockCluster, "fork");
      const orch = new Orchestrator(cfg({ workers: 2 }));
      orch.use({
        name: "sizing",
        install: (o) => {
          o.patchWorkerEnv({ NODE_OPTIONS: "--max-old-space-size=256" });
        },
      });
      await orch.run(() => {});

      expect(forkSpy).toHaveBeenCalledTimes(2);
      for (const call of forkSpy.mock.calls) {
        expect(call[0]).toMatchObject({ NODE_OPTIONS: "--max-old-space-size=256" });
      }
    });

    it("plugins are installed in worker processes too", async () => {
      mockCluster.isPrimary = false;
      const install = vi.fn();
      const orch = new Orchestrator(cfg({ workers: 2 }));
      orch.use({ name: "p", install });
      await orch.run(() => {});
      expect(install).toHaveBeenCalledOnce();
    });

    it("overrideWorkerCount() and patchWorkerEnv() throw after workers have been forked", async () => {
      mockCluster.isPrimary = true;
      const prevWebConcurrency = process.env.WEB_CONCURRENCY;
      process.env.WEB_CONCURRENCY = "2";

      try {
        const orch = new Orchestrator(cfg({ workers: "auto" }));
        await orch.run(() => {});
        expect(() => orch.overrideWorkerCount(3)).toThrow("after workers have been forked");
        expect(() => orch.patchWorkerEnv({ FOO: "bar" })).toThrow("after workers have been forked");
      } finally {
        if (prevWebConcurrency === undefined) {
          delete process.env.WEB_CONCURRENCY;
        } else {
          process.env.WEB_CONCURRENCY = prevWebConcurrency;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  describe("patchWorkerEnv — prototype pollution guard", () => {
    it("rejects __proto__ key", () => {
      const orch = new Orchestrator(cfg({ workers: 2 }));
      const env = JSON.parse('{"__proto__": {"polluted": true}}') as NodeJS.ProcessEnv;
      expect(() => orch.patchWorkerEnv(env)).toThrow(/__proto__/);
    });

    it("rejects constructor key", () => {
      const orch = new Orchestrator(cfg({ workers: 2 }));
      expect(() => orch.patchWorkerEnv({ constructor: { foo: "bar" } } as NodeJS.ProcessEnv)).toThrow(/constructor/);
    });

    it("rejects prototype key", () => {
      const orch = new Orchestrator(cfg({ workers: 2 }));
      expect(() => orch.patchWorkerEnv({ prototype: { foo: "bar" } } as NodeJS.ProcessEnv)).toThrow(/prototype/);
    });

    it("does not pollute Object.prototype after valid calls", () => {
      const orch = new Orchestrator(cfg({ workers: 2 }));
      orch.patchWorkerEnv({ NODE_ENV: "test" });
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  describe("worker crash and restart", () => {
    // workers must be >= 2 to enter cluster primary mode (workers=1 → single-worker mode)
    async function setupPrimary(workerCount: number | "auto" = 2, extra = {}) {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: workerCount, restart: { backoffMs: 0 }, ...extra }));
      await orch.run(() => {});
      return orch;
    }

    it("should restart a crashed worker", async () => {
      const _orch = await setupPrimary(2);
      const worker = Object.values(mockCluster.workers)[0];
      mockCluster.emit("exit", worker, 1, null);
      // 2 initial + 1 replacement = 3
      expect(Object.keys(mockCluster.workers).length).toBe(3);
    });

    it("should emit worker:crash on unclean exit", async () => {
      const orch = await setupPrimary(2);
      const crashEvents: unknown[] = [];
      orch.on("worker:crash", (d) => crashEvents.push(d));
      const worker = Object.values(mockCluster.workers)[0];
      mockCluster.emit("exit", worker, 1, null);
      expect(crashEvents.length).toBe(1);
    });

    it("should emit worker:restart after crash", async () => {
      const orch = await setupPrimary(2);
      const restartEvents: unknown[] = [];
      orch.on("worker:restart", (d) => restartEvents.push(d));
      const worker = Object.values(mockCluster.workers)[0];
      mockCluster.emit("exit", worker, 1, null);
      expect(restartEvents.length).toBe(1);
    });

    it("should increment workerRestarts metric", async () => {
      const orch = await setupPrimary(2);
      const worker = Object.values(mockCluster.workers)[0];
      mockCluster.emit("exit", worker, 1, null);
      expect(orch.getMetrics().workerRestarts).toBe(1);
    });

    it("should not duplicate workerExecArgv across restarts", async () => {
      const orch = await setupPrimary(2, {
        workers: { execArgv: ["--max-old-space-size=512"] },
      });

      expect(mockCluster.setupPrimary).toHaveBeenCalledWith({
        execArgv: [...process.execArgv, "--max-old-space-size=512"],
      });

      const worker = Object.values(mockCluster.workers)[0];
      mockCluster.emit("exit", worker, 1, null);

      expect(mockCluster.setupPrimary).toHaveBeenLastCalledWith({
        execArgv: [...process.execArgv, "--max-old-space-size=512"],
      });
      expect(orch.getMetrics().workerRestarts).toBe(1);
    });

    it("should not restart a gracefully disconnected worker", async () => {
      const orch = await setupPrimary(2);
      const restartEvents: unknown[] = [];
      orch.on("worker:restart", (d) => restartEvents.push(d));
      const worker = Object.values(mockCluster.workers)[0];
      worker.exitedAfterDisconnect = true;
      mockCluster.emit("exit", worker, 0, null);
      expect(restartEvents.length).toBe(0);
      expect(Object.keys(mockCluster.workers).length).toBe(2); // no new worker forked
    });

    it("should emit worker:exit on graceful worker shutdown", async () => {
      const orch = await setupPrimary(2);
      const exitEvents: Array<{ workerId: number; graceful: boolean }> = [];
      orch.on("worker:exit", (data) => exitEvents.push({ workerId: data.workerId, graceful: data.graceful }));

      const worker = Object.values(mockCluster.workers)[0];
      worker.exitedAfterDisconnect = true;
      mockCluster.emit("exit", worker, 0, null);

      expect(exitEvents).toEqual([{ workerId: worker.id, graceful: true }]);
    });

    it("should restart all crashed workers when crashes overlap", async () => {
      vi.useFakeTimers();
      const orch = await setupPrimary(3, { restart: { backoffMs: 1_000 } });

      const restartEvents: unknown[] = [];
      orch.on("worker:restart", (d) => restartEvents.push(d));

      const [first, second] = Object.values(mockCluster.workers);
      mockCluster.emit("exit", first, 1, null);
      mockCluster.emit("exit", second, 1, null);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(restartEvents.length).toBe(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(restartEvents.length).toBe(2);
      expect(orch.getMetrics().activeWorkers).toBe(3);
    });

    it("should not double-increment restart backoff after a crash", async () => {
      vi.useFakeTimers();
      const orch = await setupPrimary(2, {
        restart: {
          backoffMs: 1_000,
          backoffMultiplier: 2,
          stabilityWindowMs: 5_000,
        },
      });

      const first = Object.values(mockCluster.workers)[0];
      mockCluster.emit("exit", first, 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(orch.getMetrics().workerRestarts).toBe(1);

      const second = Object.values(mockCluster.workers).at(-1);
      expect(second).toBeDefined();
      mockCluster.emit("exit", second, 1, null);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(orch.getMetrics().workerRestarts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(orch.getMetrics().workerRestarts).toBe(2);
    });

    it("should keep elevated backoff while stability window is not reached", async () => {
      vi.useFakeTimers();
      const orch = await setupPrimary(2, {
        restart: {
          backoffMs: 1_000,
          backoffMultiplier: 2,
          stabilityWindowMs: 5_000,
        },
      });

      const first = Object.values(mockCluster.workers)[0];
      mockCluster.emit("exit", first, 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(orch.getMetrics().workerRestarts).toBe(1);

      const second = Object.values(mockCluster.workers).at(-1);
      expect(second).toBeDefined();
      mockCluster.emit("exit", second, 1, null);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(orch.getMetrics().workerRestarts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(orch.getMetrics().workerRestarts).toBe(2);
    });

    it("should keep elevated backoff when another worker stays healthy during partial flapping", async () => {
      vi.useFakeTimers();
      const orch = await setupPrimary(3, {
        restart: {
          backoffMs: 1_000,
          backoffMultiplier: 2,
          stabilityWindowMs: 5_000,
        },
      });

      const [flappingWorker, healthyWorker] = Object.values(mockCluster.workers);
      mockCluster.emit("exit", flappingWorker, 1, null);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(orch.getMetrics().workerRestarts).toBe(1);

      mockCluster.emit("online", healthyWorker);
      await vi.advanceTimersByTimeAsync(4_999);

      const replacement = Object.values(mockCluster.workers).at(-1);
      expect(replacement).toBeDefined();
      mockCluster.emit("exit", replacement, 1, null);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(orch.getMetrics().workerRestarts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(orch.getMetrics().workerRestarts).toBe(2);
    });

    it("should reset backoff after the stability window elapses", async () => {
      vi.useFakeTimers();
      const orch = await setupPrimary(2, {
        restart: {
          backoffMs: 1_000,
          backoffMultiplier: 2,
          stabilityWindowMs: 2_000,
        },
      });

      const first = Object.values(mockCluster.workers)[0];
      mockCluster.emit("exit", first, 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(orch.getMetrics().workerRestarts).toBe(1);

      const restarted = Object.values(mockCluster.workers).at(-1);
      expect(restarted).toBeDefined();

      // Ensure a deterministic online signal for stability-window reset scheduling
      mockCluster.emit("online", restarted);

      await vi.advanceTimersByTimeAsync(10_000);

      mockCluster.emit("exit", restarted, 1, null);

      await vi.advanceTimersByTimeAsync(999);
      expect(orch.getMetrics().workerRestarts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(orch.getMetrics().workerRestarts).toBe(2);
    });

    it("should skip stale queued restarts when workers is auto and capacity is already met", async () => {
      const prevWebConcurrency = process.env.WEB_CONCURRENCY;
      process.env.WEB_CONCURRENCY = "2";

      try {
        const orch = await setupPrimary("auto");
        const restartEvents: unknown[] = [];
        orch.on("worker:restart", (d) => restartEvents.push(d));

        (
          orch as unknown as {
            pendingRestartQueue: Array<{ workerId: number; code: number | null; signal: string | null }>;
          }
        ).pendingRestartQueue.push({
          workerId: 999,
          code: 1,
          signal: null,
        });

        await (
          orch as unknown as {
            processRestartQueue: () => Promise<void>;
          }
        ).processRestartQueue();

        expect(restartEvents.length).toBe(0);
      } finally {
        if (prevWebConcurrency === undefined) {
          delete process.env.WEB_CONCURRENCY;
        } else {
          process.env.WEB_CONCURRENCY = prevWebConcurrency;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  describe("worker recycling", () => {
    it("should emit worker:recycle event for aged workers", async () => {
      vi.useFakeTimers();
      const baseTime = new Date("2026-04-12T00:00:00.000Z");
      vi.setSystemTime(baseTime);

      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: {
            count: 2,
            maxAgeMs: 150_000,
          },
        }),
      );

      const recycleEvents: Array<{ workerId: number }> = [];
      orch.on("worker:recycle", (data) => recycleEvents.push(data));

      await orch.run(() => {});

      // Advance time past maxWorkerAgeMs
      vi.setSystemTime(new Date(baseTime.getTime() + 200_000));
      await vi.advanceTimersByTimeAsync(60_001);

      // Should have emitted recycle events
      expect(recycleEvents.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  describe("worker recycle SIGKILL escalation", () => {
    it("force-kills a recycled worker that does not exit within the timeout", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-12T00:00:00.000Z"));

      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: { count: 2, maxAgeMs: 150_000 },
        }),
      );

      await orch.run(() => {});

      const initialWorkers = Object.values(mockCluster.workers);
      // Prevent the old worker from auto-exiting on disconnect so it stays
      // stuck and the kill escalation path is exercised.
      for (const w of initialWorkers) {
        w.autoExitOnDisconnect = false;
      }

      // Advance time to trigger recycling
      vi.setSystemTime(new Date("2026-04-12T00:02:30.000Z"));
      await vi.advanceTimersByTimeAsync(60_001);

      // The recycle interval forks a replacement and calls handleWorkerRecycle,
      // which waits for the new worker's "online" event (emitted via
      // setImmediate) before sending the shutdown message + disconnect.
      await vi.advanceTimersByTimeAsync(0);

      const allWorkers = Object.values(mockCluster.workers);
      // The first worker is the one being recycled (forked first, aged out).
      const oldWorker = allWorkers[0];
      // Keep isDead() returning false so the kill escalation triggers
      vi.spyOn(oldWorker, "isDead").mockReturnValue(false);

      // Advance past 5s (SIGTERM timeout) + 2s (SIGKILL timeout)
      await vi.advanceTimersByTimeAsync(5_001);
      await vi.advanceTimersByTimeAsync(2_001);

      expect(oldWorker.process.kill).toHaveBeenCalledWith("SIGTERM");
      expect(oldWorker.process.kill).toHaveBeenCalledWith("SIGKILL");
      expect(orch.getMetrics().forcedKills).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  describe("circuit breaker", () => {
    // workers must be >= 2 to enter cluster primary mode
    async function setupAndCrash(threshold: number, crashes: number) {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          restart: {
            crashThreshold: threshold,
            crashWindowMs: 60_000,
          },
        }),
      );
      const tripEvents: Array<{ crashCount: number; windowMs: number }> = [];
      orch.on("circuit-breaker:tripped", (d) => tripEvents.push(d));
      await orch.run(() => {});

      for (let i = 0; i < crashes; i++) {
        const all = Object.values(mockCluster.workers);
        const last = all[all.length - 1];
        mockCluster.emit("exit", last, 1, null);
      }
      return { orch, tripEvents };
    }

    it("should trip after reaching the threshold", async () => {
      const { tripEvents } = await setupAndCrash(3, 3);
      expect(tripEvents.length).toBe(1);
    });

    it("should not trip before the threshold", async () => {
      const { tripEvents } = await setupAndCrash(3, 2);
      expect(tripEvents.length).toBe(0);
    });

    it("should stop forking new workers after tripping", async () => {
      vi.useFakeTimers();

      const { orch } = await setupAndCrash(2, 3);

      // One restart may already be queued from the first crash before the breaker trips.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(orch.getMetrics().workerRestarts).toBe(1);

      // After tripping, no additional forks should happen.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(orch.getMetrics().workerRestarts).toBe(1);
    });

    it("should emit circuit-breaker:tripped with windowMs", async () => {
      const { tripEvents } = await setupAndCrash(2, 2);
      expect(tripEvents[0]).toMatchObject({ windowMs: 60_000 });
    });

    it("should set ready=false when the breaker trips and recover via resetCircuitBreaker()", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          restart: { crashThreshold: 2, crashWindowMs: 60_000, backoffMs: 0 },
        }),
      );
      await orch.run(() => {});

      for (let i = 0; i < 2; i++) {
        const all = Object.values(mockCluster.workers);
        mockCluster.emit("exit", all[all.length - 1], 1, null);
      }

      expect(orch.getHealth().ready).toBe(false);

      orch.resetCircuitBreaker();
      expect(orch.getHealth().ready).toBe(true);

      // Missing capacity is refilled once the breaker is reset
      await new Promise((r) => setImmediate(r));
      expect(orch.getMetrics().activeWorkers).toBe(2);
    });

    it("should not drop a crash restart while another worker is being recycled", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 2, restart: { backoffMs: 0 } }));
      await orch.run(() => {});

      const [recycled, crashed] = Object.values(mockCluster.workers);
      const internals = orch as unknown as {
        workerManager: { markForRecycling(id: number): void; forkWorker(): unknown };
      };

      // Simulate a recycle in progress: old worker marked, replacement already forked
      internals.workerManager.markForRecycling(recycled.id);
      internals.workerManager.forkWorker();

      // activeWorkers is now 3, but the recycled worker is about to exit —
      // the crash below must still be restarted
      mockCluster.emit("exit", crashed, 1, null);

      await new Promise((r) => setImmediate(r));
      expect(orch.getMetrics().workerRestarts).toBe(1);
    });

    it("should increment crashLoopBackoffs metric when metrics enabled", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          restart: {
            crashThreshold: 2,
            crashWindowMs: 60_000,
          },
        }),
      );
      await orch.run(() => {});

      for (let i = 0; i < 2; i++) {
        const all = Object.values(mockCluster.workers);
        mockCluster.emit("exit", all[all.length - 1], 1, null);
      }
      expect(orch.getMetrics().crashLoopBackoffs).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  describe("plugin system", () => {
    it("use() returns this for chaining", () => {
      const orch = new Orchestrator(cfg());
      const plugin = { name: "test", install: vi.fn() };
      expect(orch.use(plugin)).toBe(orch);
    });

    it("install() is called once during run()", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      const install = vi.fn().mockResolvedValue(undefined);
      orch.use({ name: "test", install });
      await orch.run(() => {});
      expect(install).toHaveBeenCalledOnce();
      expect(install).toHaveBeenCalledWith(orch, null, expect.any(Object));
    });

    it("multiple plugins are installed in registration order", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      const order: string[] = [];
      orch.use({
        name: "a",
        install: async () => {
          order.push("a");
        },
      });
      orch.use({
        name: "b",
        install: async () => {
          order.push("b");
        },
      });
      await orch.run(() => {});
      expect(order).toEqual(["a", "b"]);
    });

    it("uninstall() is called after shutdown:complete", async () => {
      vi.useFakeTimers();
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          shutdown: {
            timeoutMs: 1_000,
            ackTimeoutMs: 500,
            sigtermDelayMs: 300,
            sigintDelayMs: 200,
          },
        }),
      );
      const uninstall = vi.fn().mockResolvedValue(undefined);
      orch.use({ name: "test", install: vi.fn().mockResolvedValue(undefined), uninstall });
      await orch.run(() => {});

      const shutdownPromise = orch.shutdownPrimary("SIGTERM");
      await vi.runAllTimersAsync();
      await shutdownPromise;

      expect(uninstall).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it("plugin without uninstall() does not throw on shutdown", async () => {
      vi.useFakeTimers();
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          shutdown: {
            timeoutMs: 1_000,
            ackTimeoutMs: 500,
            sigtermDelayMs: 300,
            sigintDelayMs: 200,
          },
        }),
      );
      orch.use({ name: "no-uninstall", install: vi.fn().mockResolvedValue(undefined) });
      await orch.run(() => {});

      const shutdownPromise = orch.shutdownPrimary("SIGTERM");
      await expect(vi.runAllTimersAsync().then(() => shutdownPromise)).resolves.not.toThrow();
      vi.useRealTimers();
    });
  });

  // --------------------------------------------------------------------------
  describe("auto worker count", () => {
    it("should clamp WEB_CONCURRENCY to a sane maximum", () => {
      const prevWebConcurrency = process.env.WEB_CONCURRENCY;
      process.env.WEB_CONCURRENCY = "10000";

      try {
        const orch = new Orchestrator(cfg({ workers: "auto" }));
        expect(orch.workerCount).toBe(256);
      } finally {
        if (prevWebConcurrency === undefined) {
          delete process.env.WEB_CONCURRENCY;
        } else {
          process.env.WEB_CONCURRENCY = prevWebConcurrency;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  describe("IPC message prefix", () => {
    it('should use default prefix "__wm"', () => {
      // Verified indirectly: construction succeeds and IPC types are derived from prefix
      expect(() => new Orchestrator(cfg())).not.toThrow();
    });

    it("should accept a custom messagePrefix", () => {
      expect(() => new Orchestrator(cfg({ shutdown: { messagePrefix: "myapp" } }))).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  describe("shutdown events", () => {
    it("should emit shutdown:start synchronously when shutdownPrimary is called", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 1,
          shutdown: {
            timeoutMs: 1_000,
            ackTimeoutMs: 500,
            sigtermDelayMs: 300,
            sigintDelayMs: 200,
          },
        }),
      );
      await orch.run(() => {});

      const events: unknown[] = [];
      orch.on("shutdown:start", (d) => events.push(d));

      // shutdownPrimary emits the event synchronously before the first await
      void orch.shutdownPrimary("SIGTERM");
      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({ signal: "SIGTERM" });
    });

    it("should set ready=false on shutdown", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 1,
          shutdown: {
            timeoutMs: 1_000,
            ackTimeoutMs: 500,
            sigtermDelayMs: 300,
            sigintDelayMs: 200,
          },
        }),
      );
      await orch.run(() => {});

      void orch.shutdownPrimary("SIGTERM");
      expect(orch.getHealth().ready).toBe(false);
    });

    it("should be idempotent (second call is a no-op)", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 1,
          shutdown: {
            timeoutMs: 1_000,
            ackTimeoutMs: 500,
            sigtermDelayMs: 300,
            sigintDelayMs: 200,
          },
        }),
      );
      await orch.run(() => {});

      const events: unknown[] = [];
      orch.on("shutdown:start", (d) => events.push(d));

      void orch.shutdownPrimary("SIGTERM");
      void orch.shutdownPrimary("SIGINT");
      expect(events.length).toBe(1); // only one event emitted
    });

    it("should keep external cluster listeners after shutdown dispose", async () => {
      vi.useFakeTimers();
      mockCluster.isPrimary = true;

      const externalOnlineListener = vi.fn();
      const externalExitListener = vi.fn();
      mockCluster.on("online", externalOnlineListener);
      mockCluster.on("exit", externalExitListener);

      const orch = new Orchestrator(
        cfg({
          workers: 2,
          shutdown: {
            timeoutMs: 1_000,
            ackTimeoutMs: 500,
            sigtermDelayMs: 300,
            sigintDelayMs: 200,
          },
        }),
      );
      await orch.run(() => {});

      expect(mockCluster.listenerCount("online")).toBe(2);
      expect(mockCluster.listenerCount("exit")).toBe(2);

      const workers = Object.values(mockCluster.workers);
      workers.forEach((worker) => {
        worker.autoExitOnDisconnect = true;
      });

      const shutdownPromise = orch.shutdownPrimary("SIGTERM");
      await vi.runAllTimersAsync();
      await shutdownPromise;

      expect(mockCluster.listenerCount("online")).toBe(1);
      expect(mockCluster.listenerCount("exit")).toBe(1);

      const onlineCallsBefore = externalOnlineListener.mock.calls.length;
      const exitCallsBefore = externalExitListener.mock.calls.length;
      const probeWorker = new MockWorker(999);

      mockCluster.emit("online", probeWorker);
      mockCluster.emit("exit", probeWorker, 0, null);

      expect(externalOnlineListener).toHaveBeenCalledTimes(onlineCallsBefore + 1);
      expect(externalExitListener).toHaveBeenCalledTimes(exitCallsBefore + 1);
    });

    it("should disconnect worker after shutdown ACK", async () => {
      vi.useFakeTimers();
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          shutdown: {
            timeoutMs: 1_000,
            ackTimeoutMs: 500,
            sigtermDelayMs: 300,
            sigintDelayMs: 200,
          },
        }),
      );
      await orch.run(() => {});

      const workers = Object.values(mockCluster.workers);
      workers.forEach((worker) => {
        worker.autoExitOnDisconnect = true;
      });

      const firstWorkerDisconnectSpy = vi.spyOn(workers[0], "disconnect");
      const secondWorkerDisconnectSpy = vi.spyOn(workers[1], "disconnect");

      const shutdownPromise = orch.shutdownPrimary("SIGTERM");

      expect(firstWorkerDisconnectSpy).not.toHaveBeenCalled();
      expect(secondWorkerDisconnectSpy).not.toHaveBeenCalled();

      workers[0].emit("message", { type: "__wm:shutdown-ack" });

      expect(firstWorkerDisconnectSpy).toHaveBeenCalledOnce();
      expect(secondWorkerDisconnectSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(secondWorkerDisconnectSpy).toHaveBeenCalledOnce();

      await shutdownPromise;
    });

    it("should not wait for ACK timeout when worker exits before ACK", async () => {
      vi.useFakeTimers();
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          shutdown: {
            timeoutMs: 1_000,
            ackTimeoutMs: 500,
            sigtermDelayMs: 300,
            sigintDelayMs: 200,
          },
        }),
      );
      await orch.run(() => {});

      const workers = Object.values(mockCluster.workers);
      workers[1].autoExitOnDisconnect = true;

      const firstWorkerDisconnectSpy = vi.spyOn(workers[0], "disconnect");
      const secondWorkerDisconnectSpy = vi.spyOn(workers[1], "disconnect");

      const shutdownPromise = orch.shutdownPrimary("SIGTERM");

      workers[0].simulateGracefulExit();

      await vi.advanceTimersByTimeAsync(499);
      expect(firstWorkerDisconnectSpy).not.toHaveBeenCalled();
      expect(secondWorkerDisconnectSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(firstWorkerDisconnectSpy).not.toHaveBeenCalled();
      expect(secondWorkerDisconnectSpy).toHaveBeenCalledOnce();

      await shutdownPromise;
    });

    it("should disconnect worker only after ACK timeout when no ACK is received", async () => {
      vi.useFakeTimers();
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          shutdown: {
            timeoutMs: 1_000,
            ackTimeoutMs: 500,
            sigtermDelayMs: 300,
            sigintDelayMs: 200,
          },
        }),
      );
      await orch.run(() => {});

      const workers = Object.values(mockCluster.workers);
      workers.forEach((worker) => {
        worker.autoExitOnDisconnect = true;
      });

      const workerDisconnectSpy = vi.spyOn(workers[0], "disconnect");

      const shutdownPromise = orch.shutdownPrimary("SIGTERM");

      await vi.advanceTimersByTimeAsync(499);
      expect(workerDisconnectSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(workerDisconnectSpy).toHaveBeenCalledOnce();

      await shutdownPromise;
    });
  });
});
