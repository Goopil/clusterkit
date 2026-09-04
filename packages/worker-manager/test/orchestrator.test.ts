import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../src/orchestrator";
import { getCPUCount } from "../src/sizing";
import { WorkerManagerValidationError } from "../src/validation";

// ============================================================================
// Mock cluster helpers
// ============================================================================

class MockWorker extends EventEmitter {
  id: number;
  process: EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> };
  exitedAfterDisconnect = false;
  autoExitOnDisconnect = false;
  private _isDead = false;
  private _isConnected = true;

  constructor(id: number) {
    super();
    this.id = id;
    // The real worker.process is a ChildProcess (an EventEmitter): the drain
    // path attaches a no-op 'error' listener to it, so the mock mirrors that.
    this.process = Object.assign(new EventEmitter(), { pid: 1000 + id, kill: vi.fn() });
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
  // Breaker-trip tests would otherwise print real ClusterKitCrashLoop warnings
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
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
  // the gracefulShutdowns counter was never asserted —
  // deleting both increment sites passed CI. Each site gets its own test.
  describe("gracefulShutdowns metric", () => {
    it("increments when a worker exits gracefully during shutdown", async () => {
      vi.useFakeTimers();
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          shutdown: { timeoutMs: 1_000, ackTimeoutMs: 500, sigtermDelayMs: 300, sigintDelayMs: 200 },
        }),
      );
      await orch.run(() => {});
      for (const w of Object.values(mockCluster.workers)) {
        w.autoExitOnDisconnect = true;
      }

      const shutdownPromise = orch.shutdownPrimary("SIGTERM");
      expect(orch.getMetrics().gracefulShutdowns).toBe(0);

      // Graceful exit (exitedAfterDisconnect) while shutdown is in progress
      const [w1] = Object.values(mockCluster.workers);
      w1.exitedAfterDisconnect = true;
      mockCluster.emit("exit", w1, 0, null);
      expect(orch.getMetrics().gracefulShutdowns).toBe(1);

      await vi.runAllTimersAsync();
      await shutdownPromise;
      expect(orch.getMetrics().gracefulShutdowns).toBe(1);
    });

    it("increments when a worker exits gracefully outside shutdown", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 2, restart: { backoffMs: 0 } }));
      await orch.run(() => {});

      const w = Object.values(mockCluster.workers)[0];
      w.exitedAfterDisconnect = true;
      mockCluster.emit("exit", w, 0, null);

      expect(orch.getMetrics().gracefulShutdowns).toBe(1);
      expect(orch.getMetrics().workerRestarts).toBe(0); // graceful exit must not restart
    });
  });

  // --------------------------------------------------------------------------
  describe("getHealth", () => {
    it("should return { ready, live }", () => {
      const health = new Orchestrator(cfg()).getHealth();
      expect(health).toHaveProperty("ready", true);
      expect(health).toHaveProperty("live", true);
    });

    // health.live is constant by design: a live primary with a tripped breaker
    // is still alive — readiness carries the failure signal, not liveness.
    it("keeps live=true even after the circuit breaker trips", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          restart: { crashThreshold: 2, crashWindowMs: 60_000 },
        }),
      );
      await orch.run(() => {});

      for (let i = 0; i < 2; i++) {
        const all = Object.values(mockCluster.workers);
        mockCluster.emit("exit", all[all.length - 1], 1, null);
      }

      expect(orch.getHealth()).toEqual({ ready: false, live: true });
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
  // the shutdown guard in setReady() had zero coverage —
  // removing it would flip readiness back to true during a shutdown.
  describe("setReady", () => {
    it("is a no-op while a shutdown is in progress", async () => {
      vi.useFakeTimers();
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          shutdown: { timeoutMs: 1_000, ackTimeoutMs: 500, sigtermDelayMs: 300, sigintDelayMs: 200 },
        }),
      );
      await orch.run(() => {});
      for (const w of Object.values(mockCluster.workers)) {
        w.autoExitOnDisconnect = true;
      }

      const shutdownPromise = orch.shutdownPrimary("SIGTERM");
      expect(orch.getHealth().ready).toBe(false);

      orch.setReady();
      expect(orch.getHealth().ready).toBe(false); // must stay false during shutdown

      await vi.runAllTimersAsync();
      await shutdownPromise;
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

    it("should run callbacks during multi-worker primary shutdown, before plugin uninstall", async () => {
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
      const order: string[] = [];
      orch.use({
        name: "p",
        install: vi.fn().mockResolvedValue(undefined),
        uninstall: async () => {
          order.push("uninstall");
        },
      });
      await orch.run(() => {});

      const onShutdown = vi.fn(async () => {
        order.push("callback");
      });
      orch.registerOnShutdown(onShutdown);

      for (const w of Object.values(mockCluster.workers)) {
        w.autoExitOnDisconnect = true;
      }
      const shutdownPromise = orch.shutdownPrimary("SIGTERM");
      await vi.runAllTimersAsync();
      await shutdownPromise;

      expect(order).toEqual(["callback", "uninstall"]);
      expect(onShutdown).toHaveBeenCalledWith("SIGTERM");
    });

    // removing the per-callback try/catch passed CI — a
    // throwing callback aborted runShutdownCallbacks, skipping every later
    // callback, the plugin uninstall, and the shutdown:complete emission.
    it("a throwing shutdown callback must not break the drain chain", async () => {
      vi.useFakeTimers();
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          shutdown: { timeoutMs: 1_000, ackTimeoutMs: 500, sigtermDelayMs: 300, sigintDelayMs: 200 },
        }),
      );
      const order: string[] = [];
      orch.use({
        name: "p",
        install: vi.fn().mockResolvedValue(undefined),
        uninstall: async () => {
          order.push("uninstall");
        },
      });
      await orch.run(() => {});
      for (const w of Object.values(mockCluster.workers)) {
        w.autoExitOnDisconnect = true;
      }

      orch.registerOnShutdown(() => {
        order.push("cb-1");
        throw new Error("callback boom");
      });
      orch.registerOnShutdown(async () => {
        order.push("cb-2");
      });
      const completeEvents: unknown[] = [];
      orch.on("shutdown:complete", (d) => completeEvents.push(d));

      const shutdownPromise = orch.shutdownPrimary("SIGTERM");
      await vi.runAllTimersAsync();
      await expect(shutdownPromise).resolves.toBeUndefined();

      expect(order).toEqual(["cb-1", "cb-2", "uninstall"]);
      expect(completeEvents).toHaveLength(1);
    });

    // #144: multi-worker shutdownPrimary awaited user callbacks with no
    // failsafe — one callback that never resolves would hang the primary
    // after SIGTERM forever (single-worker mode and worker children already
    // force-exit on timeout).
    it("force-exits when a multi-worker shutdown callback never resolves", async () => {
      vi.useFakeTimers();
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          shutdown: { timeoutMs: 4_000, ackTimeoutMs: 1_000, sigtermDelayMs: 300, sigintDelayMs: 200 },
        }),
      );
      await orch.run(() => {});
      orch.registerOnShutdown(() => new Promise<void>(() => {})); // never resolves
      for (const w of Object.values(mockCluster.workers)) {
        w.autoExitOnDisconnect = true;
      }

      const exitSpy = vi.mocked(process.exit);
      void orch.shutdownPrimary("SIGTERM");

      // The failsafe wraps the callbacks+uninstall phase: it arms only after
      // the coordinator phase (~1s of ACK budget) and fires one timeoutMs later.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(exitSpy).toHaveBeenCalledWith(1);
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

    it("should reject values above the maximum", () => {
      const orch = new Orchestrator(cfg({ workers: "auto" }));
      expect(() => orch.overrideWorkerCount(257)).toThrow(/maximum/);
    });

    it("should accept a value at the maximum and apply it", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: "auto" }));
      orch.overrideWorkerCount(256);
      await orch.run(() => {});
      expect(Object.keys(mockCluster.workers)).toHaveLength(256);
    });
  });

  // --------------------------------------------------------------------------
  describe("run() — primary mode (isPrimary = true, workers > 1)", () => {
    it("should fork the requested number of workers", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 3 }));
      await orch.run(() => {});
      expect(Object.keys(mockCluster.workers)).toHaveLength(3);
    });

    it("should register signal handlers before forking the first worker", async () => {
      mockCluster.isPrimary = true;
      const onSpy = vi.spyOn(process, "on");
      const forkSpy = vi.spyOn(mockCluster, "fork");

      const orch = new Orchestrator(cfg({ workers: 2 }));
      await orch.run(() => {});

      const sigtermRegistrations = onSpy.mock.calls.filter(([signal]) => signal === "SIGTERM");
      expect(sigtermRegistrations).toHaveLength(1);
      expect(forkSpy).toHaveBeenCalledTimes(2);
      // A SIGTERM arriving between fork and register would kill the primary
      // with Node's default handler and orphan the fleet (#93).
      const sigtermIdx = onSpy.mock.invocationCallOrder[onSpy.mock.calls.findIndex(([signal]) => signal === "SIGTERM")];
      expect(sigtermIdx).toBeLessThan(forkSpy.mock.invocationCallOrder[0]);
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
      expect(events).toHaveLength(2);
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
      expect(Object.keys(mockCluster.workers)).toHaveLength(0);
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
      expect(Object.keys(mockCluster.workers)).toHaveLength(0);
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
      expect(Object.keys(mockCluster.workers)).toHaveLength(3);
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
      expect(Object.keys(mockCluster.workers)).toHaveLength(3);
    });

    it("should emit worker:crash on unclean exit", async () => {
      const orch = await setupPrimary(2);
      const crashEvents: unknown[] = [];
      orch.on("worker:crash", (d) => crashEvents.push(d));
      const worker = Object.values(mockCluster.workers)[0];
      mockCluster.emit("exit", worker, 1, null);
      expect(crashEvents).toHaveLength(1);
    });

    it("should emit worker:restart after crash", async () => {
      const orch = await setupPrimary(2);
      const restartEvents: unknown[] = [];
      orch.on("worker:restart", (d) => restartEvents.push(d));
      const worker = Object.values(mockCluster.workers)[0];
      mockCluster.emit("exit", worker, 1, null);
      expect(restartEvents).toHaveLength(1);
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
      expect(restartEvents).toHaveLength(0);
      expect(Object.keys(mockCluster.workers)).toHaveLength(2); // no new worker forked
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

    it("should terminate a replacement forked before shutdown together with the initial fleet", async () => {
      vi.useFakeTimers();
      const orch = await setupPrimary(2, {
        restart: { backoffMs: 1_000 },
        shutdown: {
          timeoutMs: 1_000,
          ackTimeoutMs: 500,
          sigtermDelayMs: 300,
          sigintDelayMs: 200,
        },
      });
      await vi.advanceTimersByTimeAsync(0); // flush initial "online" setImmediates

      // Crash + full restart completes BEFORE shutdown begins
      mockCluster.emit("exit", Object.values(mockCluster.workers)[0], 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(orch.getMetrics().workerRestarts).toBe(1);

      for (const w of Object.values(mockCluster.workers)) {
        w.autoExitOnDisconnect = true;
      }
      const shutdownPromise = orch.shutdownPrimary("SIGTERM");
      await vi.runAllTimersAsync();
      await shutdownPromise;

      // The replacement (not part of the initial fleet) is in the kill list too
      expect(Object.keys(mockCluster.workers)).toHaveLength(3);
      for (const w of Object.values(mockCluster.workers)) {
        expect(w.isDead()).toBe(true);
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
  describe("restartWorkers()", () => {
    async function setupPrimary(workerCount: number | "auto" = 2, extra = {}) {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: workerCount, restart: { backoffMs: 0 }, ...extra }));
      await orch.run(() => {});
      return orch;
    }

    it("replaces all workers with rolling restart", async () => {
      const orchestrator = await setupPrimary(3);
      const originalIds = Object.values(mockCluster.workers).map((w) => w!.id);

      for (const w of Object.values(mockCluster.workers)) {
        w!.autoExitOnDisconnect = true;
      }

      const restartStartEvents: Array<{ reason: string; workerIds: number[] }> = [];
      const restartCompleteEvents: Array<{ restartedWorkerIds: number[]; reason: string }> = [];
      orchestrator.on("restart:start", (d) => restartStartEvents.push(d));
      orchestrator.on("restart:complete", (d) => restartCompleteEvents.push(d));

      await orchestrator.restartWorkers({ staggerMs: 0, reason: "test" });

      expect(restartStartEvents).toHaveLength(1);
      expect(restartStartEvents[0].reason).toBe("test");
      expect(restartStartEvents[0].workerIds).toHaveLength(3);

      expect(restartCompleteEvents).toHaveLength(1);
      expect(restartCompleteEvents[0].restartedWorkerIds).toHaveLength(3);
      expect(restartCompleteEvents[0].reason).toBe("test");

      for (const id of originalIds) {
        const w = mockCluster.workers[id];
        expect(w?.isDead()).toBe(true);
      }
    });

    it("is idempotent — second call during restart is a no-op", async () => {
      const orchestrator = await setupPrimary(2);

      for (const w of Object.values(mockCluster.workers)) {
        w!.autoExitOnDisconnect = true;
      }

      const completeEvents: Array<{ reason: string }> = [];
      orchestrator.on("restart:complete", (d) => completeEvents.push(d));

      const p1 = orchestrator.restartWorkers({ staggerMs: 50, reason: "first" });
      const p2 = orchestrator.restartWorkers({ staggerMs: 50, reason: "second" });

      await Promise.all([p1, p2]);

      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].reason).toBe("first");
    });

    it("returns early in single-worker mode", async () => {
      mockCluster.isPrimary = true;
      const orchestrator = new Orchestrator(cfg({ workers: 1 }));
      await orchestrator.run(() => {});

      const events: Array<{ reason: string }> = [];
      orchestrator.on("restart:start", (d) => events.push(d));

      await orchestrator.restartWorkers({ reason: "test" });

      expect(events).toHaveLength(0);
    });

    it("passes env overlay to forked workers", async () => {
      const orchestrator = await setupPrimary(2);
      const forkCalls = vi.spyOn(mockCluster, "fork");

      for (const w of Object.values(mockCluster.workers)) {
        w!.autoExitOnDisconnect = true;
      }

      await orchestrator.restartWorkers({ env: { HOT_RESTART_KEY: "value" }, staggerMs: 0, reason: "env-test" });

      const hasOverlay = forkCalls.mock.calls.some(
        (call: unknown[]) => call[0] && (call[0] as NodeJS.ProcessEnv).HOT_RESTART_KEY === "value",
      );
      expect(hasOverlay).toBe(true);
    });

    it("rejects a restart env overlay containing prototype-pollution keys", async () => {
      const orchestrator = await setupPrimary(2);
      const forkSpy = vi.spyOn(mockCluster, "fork");

      // JSON.parse (not an object literal): it defines `__proto__` as a real
      // own enumerable property, which the env guard's Object.keys() scan must
      // see. The `__proto__:` literal syntax only sets the prototype instead,
      // so Object.keys() would never list it.
      const badEnv = JSON.parse('{"__proto__": "x"}') as NodeJS.ProcessEnv;

      await expect(orchestrator.restartWorkers({ env: badEnv, staggerMs: 0, reason: "proto-guard" })).rejects.toThrow(
        WorkerManagerValidationError,
      );

      // The polluted overlay never reached a fork.
      expect(forkSpy).not.toHaveBeenCalled();
      expect(Object.keys(mockCluster.workers)).toHaveLength(2);
    });

    it("fails fast on a polluted env overlay before marking workers for recycling", async () => {
      const orchestrator = await setupPrimary(2);
      const forkSpy = vi.spyOn(mockCluster, "fork");

      const restartStartEvents: Array<{ reason: string }> = [];
      orchestrator.on("restart:start", (d) => restartStartEvents.push(d));

      const badEnv = JSON.parse('{"__proto__": "x"}') as NodeJS.ProcessEnv;

      await expect(orchestrator.restartWorkers({ env: badEnv, staggerMs: 0, reason: "fail-fast" })).rejects.toThrow(
        WorkerManagerValidationError,
      );

      // The aborted roll must leave no trace: no fork, no recycling mark (a
      // stale mark would silently exempt the old worker from age-based
      // recycling), and no restart:start without a matching restart:complete.
      expect(forkSpy).not.toHaveBeenCalled();
      const internals = orchestrator as unknown as { workerManager: { getRecyclingCount(): number } };
      expect(internals.workerManager.getRecyclingCount()).toBe(0);
      expect(restartStartEvents).toHaveLength(0);

      // The guard fired before restartInProgress was set — a valid restart still works.
      for (const w of Object.values(mockCluster.workers)) {
        w!.autoExitOnDisconnect = true;
      }
      await expect(
        orchestrator.restartWorkers({ env: {}, staggerMs: 0, reason: "after-abort" }),
      ).resolves.toBeUndefined();
    });

    it("respects filter to restart only matching workers", async () => {
      const orchestrator = await setupPrimary(3);

      for (const w of Object.values(mockCluster.workers)) {
        w!.autoExitOnDisconnect = true;
      }

      const allIds = Object.values(mockCluster.workers).map((w) => w!.id);
      const targetId = allIds[0];

      const completeEvents: Array<{ restartedWorkerIds: number[] }> = [];
      orchestrator.on("restart:complete", (d) => completeEvents.push(d));

      await orchestrator.restartWorkers({
        filter: (id) => id === targetId,
        staggerMs: 0,
        reason: "filter-test",
      });

      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].restartedWorkerIds).toEqual([targetId]);
    });

    // Fast shutdown budget keeps the bounded exit waits short under fake
    // timers: exitWaitMs = 1000 + 100 + 100 + 5000 = 6200ms.
    const FAST_SHUTDOWN = {
      shutdown: {
        timeoutMs: 1_000,
        ackTimeoutMs: 500,
        sigtermDelayMs: 100,
        sigintDelayMs: 100,
      },
    };

    /**
     * Advance fake timers concurrently with `promise` and report whether it
     * settled before the virtual clock budget ran out. Keeps timer-driven
     * assertions self-bounding: a broken (never-settling) implementation
     * fails the test instead of hanging the suite.
     */
    async function settleWithinBudget(
      promise: Promise<unknown>,
      budgetMs: number,
    ): Promise<"resolved" | "rejected" | "deadline"> {
      const clockDone = vi.advanceTimersByTimeAsync(budgetMs).then(() => "deadline" as const);
      const outcome = await Promise.race([
        promise.then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
        clockDone,
      ]);
      // Let the background clock advance finish before the next clock interaction.
      await clockDone;
      return outcome;
    }

    /** Make every subsequent fork return a worker that never emits "online". */
    function mockForkNeverOnline(): ReturnType<typeof vi.spyOn> {
      let doomedId = 1000;
      return vi.spyOn(mockCluster, "fork").mockImplementation((_env?: NodeJS.ProcessEnv) => {
        const worker = new MockWorker(doomedId++);
        mockCluster.workers[worker.id] = worker;
        return worker;
      });
    }

    it("completes restart and resets restartInProgress when replacement never comes online", async () => {
      vi.useFakeTimers();
      const orchestrator = await setupPrimary(2, FAST_SHUTDOWN);

      const restartStartEvents: Array<{ reason: string; workerIds: number[] }> = [];
      const restartCompleteEvents: Array<{ restartedWorkerIds: number[]; reason: string }> = [];
      orchestrator.on("restart:start", (d) => restartStartEvents.push(d));
      orchestrator.on("restart:complete", (d) => restartCompleteEvents.push(d));

      // Replacements never reach "online" (OOM at boot): the drain escalation
      // in handleWorkerRecycle never arms, so only the bounded exit wait in
      // restartWorkers() can unblock the roll.
      const forkSpy = mockForkNeverOnline();

      const restartPromise = orchestrator.restartWorkers({ staggerMs: 0, reason: "stuck" });
      expect(await settleWithinBudget(restartPromise, 30_000)).toBe("resolved");

      expect(restartCompleteEvents).toHaveLength(1);
      expect(restartCompleteEvents[0].restartedWorkerIds).toEqual([1, 2]);

      // restartInProgress must be released — a second call is not ignored.
      forkSpy.mockRestore();
      for (const w of Object.values(mockCluster.workers)) {
        w!.autoExitOnDisconnect = true;
      }
      const second = orchestrator.restartWorkers({ staggerMs: 0, reason: "after-stuck" });
      expect(await settleWithinBudget(second, 30_000)).toBe("resolved");
      expect(restartStartEvents).toHaveLength(2);
      expect(restartCompleteEvents).toHaveLength(2);
    });

    it("forces SIGKILL when old worker never exits during restart", async () => {
      vi.useFakeTimers();
      const orchestrator = await setupPrimary(2, FAST_SHUTDOWN);

      const oldWorker = mockCluster.workers[1]!;
      // The old worker ignores the drain: no auto-exit. SIGKILL from the
      // bounded wait is the only way out — after it the worker emits "exit"
      // and the wait settles via the grace-period listener.
      oldWorker.process.kill.mockImplementation(() => {
        setImmediate(() => oldWorker.simulateGracefulExit());
      });

      mockForkNeverOnline();

      const restartPromise = orchestrator.restartWorkers({ staggerMs: 0, reason: "test" });
      expect(await settleWithinBudget(restartPromise, 30_000)).toBe("resolved");

      expect(oldWorker.process.kill).toHaveBeenCalledWith("SIGKILL");
      // Worker 1 is killed by the restart bounded wait alone (its drain
      // escalation is cleared when the SIGKILL lands): SIGKILL without a
      // prior SIGTERM.
      expect(oldWorker.process.kill).not.toHaveBeenCalledWith("SIGTERM");
      // Worker 1: bounded-wait SIGKILL. Worker 2 ignores signals entirely, so
      // after its bounded-wait SIGKILL the drain escalation armed by the
      // recycle failsafe (#144 — previously it never armed when the
      // replacement never came online) runs to completion: SIGTERM, SIGKILL.
      expect(orchestrator.getMetrics().forcedKills).toBe(3);
    });

    it("does not emit restart:complete when shutdown aborts the roll", async () => {
      vi.useFakeTimers();
      const orchestrator = await setupPrimary(2, FAST_SHUTDOWN);
      await vi.advanceTimersByTimeAsync(0); // flush initial "online" setImmediates

      const startEvents: Array<{ reason: string; workerIds: number[] }> = [];
      const completeEvents: Array<{ restartedWorkerIds: number[]; reason: string }> = [];
      orchestrator.on("restart:start", (d) => startEvents.push(d));
      orchestrator.on("restart:complete", (d) => completeEvents.push(d));

      const forkSpy = vi.spyOn(mockCluster, "fork");

      // First old worker stays alive after disconnect: the roll blocks in the
      // first awaitBoundedWorkerExit while its drain is still pending — the
      // shutdown window the abort branch must handle.
      mockCluster.workers[1]!.autoExitOnDisconnect = false;

      const restartPromise = orchestrator.restartWorkers({ staggerMs: 0, reason: "abort-test" });

      // Drain of worker 1 begins (replacement online → send + disconnect)
      await vi.advanceTimersByTimeAsync(0);

      // Shutdown starts mid-roll, during the first drain
      const shutdownPromise = orchestrator.shutdownPrimary("SIGTERM");
      expect(orchestrator.getHealth().ready).toBe(false);

      // Only worker 1's replacement was forked so far
      expect(forkSpy).toHaveBeenCalledTimes(1);

      // Bounded exit wait (6.2s) + grace period (2s) elapse, then the roll
      // hits the abort branch.
      expect(await settleWithinBudget(restartPromise, 30_000)).toBe("resolved");

      expect(startEvents).toHaveLength(1);
      // A partial roll is not a complete roll: no restart:complete.
      expect(completeEvents).toHaveLength(0);

      // No fork after shutdown initiation — the abort must not orphan
      // replacements outside initiateShutdown's kill list.
      expect(forkSpy).toHaveBeenCalledTimes(1);

      await vi.runAllTimersAsync();
      await shutdownPromise;
    });

    it("drains the old worker when the replacement dies before coming online", async () => {
      vi.useFakeTimers();
      const orchestrator = await setupPrimary(2, FAST_SHUTDOWN);

      for (const w of Object.values(mockCluster.workers)) {
        w!.autoExitOnDisconnect = true;
      }

      // Replacement crashes before ever emitting "online".
      let doomedId = 1000;
      vi.spyOn(mockCluster, "fork").mockImplementation((_env?: NodeJS.ProcessEnv) => {
        const worker = new MockWorker(doomedId++);
        mockCluster.workers[worker.id] = worker;
        setImmediate(() => worker.simulateCrash(1, null));
        return worker;
      });

      const restartPromise = orchestrator.restartWorkers({ staggerMs: 0, reason: "test" });
      expect(await settleWithinBudget(restartPromise, 30_000)).toBe("resolved");

      // Old workers were drained despite the never-online replacements.
      expect(mockCluster.workers[1]?.isDead()).toBe(true);
      expect(mockCluster.workers[2]?.isDead()).toBe(true);
    });

    // --------------------------------------------------------------------------
    describe("recycled worker IPC EPIPE (drain race)", () => {
      it("completes a roll whose old workers emit async EPIPE on drain", async () => {
        vi.useFakeTimers();
        const orchestrator = await setupPrimary(4, FAST_SHUTDOWN);
        await vi.advanceTimersByTimeAsync(0); // flush initial "online" setImmediates

        // Old workers fail their drain send asynchronously (dead IPC channel):
        // Node surfaces the failure as an 'error' event on worker.process
        // (child_process._send) AFTER the drain's sync try/catch has passed.
        for (const w of Object.values(mockCluster.workers)) {
          w!.autoExitOnDisconnect = true;
          w!.send = () => {
            setImmediate(() => {
              const err = new Error("write EPIPE") as Error & { code?: string };
              err.code = "EPIPE";
              w!.process.emit("error", err);
            });
            return true;
          };
        }

        // Probe uncaught exceptions: an escaped EPIPE must fail this test.
        let uncaught: Error | undefined;
        const onUncaught = (err: Error): void => {
          uncaught ??= err;
        };
        process.on("uncaughtException", onUncaught);

        try {
          const restartPromise = orchestrator.restartWorkers({ staggerMs: 0, reason: "epipe" });
          expect(await settleWithinBudget(restartPromise, 30_000)).toBe("resolved");
        } finally {
          process.off("uncaughtException", onUncaught);
        }

        expect(uncaught).toBeUndefined();
        // All workers exited via the drain (autoExit), not the kill backstop.
        expect(orchestrator.getMetrics().forcedKills).toBe(0);
      });

      it("routes drain send errors to a callback and swallows process IPC errors", async () => {
        vi.useFakeTimers();
        const orchestrator = await setupPrimary(2, FAST_SHUTDOWN);
        await vi.advanceTimersByTimeAsync(0);

        const oldWorker = mockCluster.workers[1]!;
        const sendSpy = vi.spyOn(oldWorker, "send");
        oldWorker.autoExitOnDisconnect = true;

        const restartPromise = orchestrator.restartWorkers({ staggerMs: 0, reason: "pin" });
        expect(await settleWithinBudget(restartPromise, 30_000)).toBe("resolved");

        // The drain shutdown message is sent with a no-op callback: cluster's
        // Worker.send() delegates to process.send(msg, cb), which routes send
        // errors ('write EPIPE', 'IPC channel closed') to the callback instead
        // of emitting them.
        const drainSend = sendSpy.mock.calls.find(
          (call) => (call[0] as { type?: string } | undefined)?.type === "__wm:shutdown",
        );
        expect(drainSend).toBeDefined();
        expect(drainSend?.[1]).toBeTypeOf("function");

        // disconnect()'s internal send has no callback: Node emits the error on
        // worker.process, so a no-op 'error' listener must be attached.
        expect(oldWorker.process.listenerCount("error")).toBeGreaterThan(0);
        expect(() => oldWorker.process.emit("error", new Error("write EPIPE"))).not.toThrow();
      });
    });

    // removing the mid-roll shutdown guard (`break`) passed
    // CI — the roll kept forking replacements after shutdown started, which
    // orphans them (the shutdown kill list is captured at initiation).
    it("aborts the roll when shutdown starts mid-roll — no further forks, no orphans", async () => {
      vi.useFakeTimers();
      const orchestrator = await setupPrimary(3, FAST_SHUTDOWN);
      await vi.advanceTimersByTimeAsync(0); // flush initial "online" setImmediates
      for (const w of Object.values(mockCluster.workers)) {
        w!.autoExitOnDisconnect = true;
      }

      const forkSpy = vi.spyOn(mockCluster, "fork");
      const restartStartEvents: Array<{ reason: string; workerIds: number[] }> = [];
      orchestrator.on("restart:start", (d) => restartStartEvents.push(d));

      // Iteration 1 completes (fork + drain + exit), then the roll parks in
      // the 200ms stagger window.
      const rollPromise = orchestrator.restartWorkers({ staggerMs: 200, reason: "mid-shutdown" });
      await vi.advanceTimersByTimeAsync(0);
      expect(forkSpy).toHaveBeenCalledTimes(1); // 1 replacement forked so far
      expect(restartStartEvents).toHaveLength(1);

      // Shutdown starts during the stagger window — every worker (including
      // the mid-roll replacement) must die with the shutdown, not orphaned.
      for (const w of Object.values(mockCluster.workers)) {
        w!.autoExitOnDisconnect = true;
      }
      const shutdownPromise = orchestrator.shutdownPrimary("SIGTERM");

      // Flush everything: the roll must stop forking after shutdown started.
      await vi.advanceTimersByTimeAsync(200);
      await vi.runAllTimersAsync();
      await Promise.all([rollPromise, shutdownPromise]);
      expect(forkSpy).toHaveBeenCalledTimes(1); // ← kills break removal

      // Drain the shutdown fully: no orphan worker may survive
      for (const w of Object.values(mockCluster.workers)) {
        expect(w!.isDead()).toBe(true); // ← mid-roll forks would survive shutdown
      }
    });

    // ------------------------------------------------------------------
    // Fork-failure resilience for the hot-restart roll: a worker that dies
    // between the snapshot and its turn must be skipped (no stale recycling
    // mark, no full drain-budget stall), and a throwing forkWorker() must
    // leave the old worker running instead of aborting the process.
    // ------------------------------------------------------------------
    describe("fork failure resilience (roll)", () => {
      let savedExitCode: typeof process.exitCode;
      beforeEach(() => {
        savedExitCode = process.exitCode;
      });
      afterEach(() => {
        process.exitCode = savedExitCode;
      });

      /**
       * Setup for roll tests: worker exits also fire the cluster-level "exit"
       * event that drives the restart bookkeeping (mirrors real cluster, where
       * both the worker and the cluster emit).
       */
      async function setupRollTest(workerCount = 2) {
        const orchestrator = await setupPrimary(workerCount, FAST_SHUTDOWN);
        await vi.advanceTimersByTimeAsync(0); // flush initial "online" setImmediates

        for (const w of Object.values(mockCluster.workers)) {
          w!.autoExitOnDisconnect = true;
          w!.on("exit", (code, signal) => mockCluster.emit("exit", w!, code, signal));
        }
        return orchestrator;
      }

      /**
       * Roll worker 1 while worker 2 crashes mid-roll (before its turn): the
       * snapshot still contains worker 2, which is dead by the time the roll
       * reaches it.
       */
      async function rollWithMidRollCrash() {
        const orchestrator = await setupRollTest();

        const [, second] = Object.values(mockCluster.workers);
        // Worker 2 crashes while the roll is parked on worker 1's stagger window
        setTimeout(() => second!.simulateCrash(1, null), 50);

        return orchestrator;
      }

      it("skips a worker that died mid-roll — no stale recycling mark", async () => {
        vi.useFakeTimers();
        const orchestrator = await rollWithMidRollCrash();

        const completeEvents: Array<{ restartedWorkerIds: number[] }> = [];
        orchestrator.on("restart:complete", (d) => completeEvents.push(d));

        const rollPromise = orchestrator.restartWorkers({ staggerMs: 1_000, reason: "stale-skip" });
        await vi.advanceTimersByTimeAsync(2_000); // drain w1, stagger park (crash at 50), skip dead w2
        await rollPromise;
        await vi.advanceTimersByTimeAsync(0); // flush the crash-restart replacement's "online"

        const internals = orchestrator as unknown as { workerManager: { getRecyclingCount(): number } };
        expect(internals.workerManager.getRecyclingCount()).toBe(0);
        expect(completeEvents).toHaveLength(1);
        expect(completeEvents[0].restartedWorkerIds).toEqual([1]); // only worker 1 was rolled
        // Capacity was restored by the crash-restart path, not the roll
        expect(orchestrator.getMetrics().activeWorkers).toBe(2);
      });

      it("does not stall the roll on a worker that died mid-roll", async () => {
        vi.useFakeTimers();
        const orchestrator = await rollWithMidRollCrash();

        const rollPromise = orchestrator.restartWorkers({ staggerMs: 1_000, reason: "no-stall" });
        // exitWaitMs under FAST_SHUTDOWN is 6.2s: a dead worker must be
        // skipped, not parked on for the full drain budget
        expect(await settleWithinBudget(rollPromise, 6_000)).toBe("resolved");
        await vi.advanceTimersByTimeAsync(0);
      });

      it("leaves the old worker running and continues the roll when a fork throws", async () => {
        vi.useFakeTimers();
        const orchestrator = await setupRollTest();

        const forkSpy = vi.spyOn(mockCluster, "fork");
        // The first roll fork fails (resource exhaustion), the second succeeds
        forkSpy.mockImplementationOnce(() => {
          throw new Error("EMFILE: too many open files");
        });

        const completeEvents: Array<{ restartedWorkerIds: number[] }> = [];
        orchestrator.on("restart:complete", (d) => completeEvents.push(d));

        const rollPromise = orchestrator.restartWorkers({ staggerMs: 0, reason: "fork-fail" });
        expect(await settleWithinBudget(rollPromise, 6_000)).toBe("resolved");

        const internals = orchestrator as unknown as { workerManager: { getRecyclingCount(): number } };
        // The failed worker was never marked for recycling and keeps serving
        expect(internals.workerManager.getRecyclingCount()).toBe(0);
        expect(completeEvents).toHaveLength(1);
        expect(completeEvents[0].restartedWorkerIds).toEqual([2]); // only worker 2 was rolled
        expect(mockCluster.workers[1]!.isDead()).toBe(false);
        expect(mockCluster.workers[2]!.isDead()).toBe(true);
      });

      it("abandons the roll and flags exit code 1 after 3 consecutive fork failures", async () => {
        vi.useFakeTimers();
        const orchestrator = await setupRollTest(3);

        vi.spyOn(mockCluster, "fork").mockImplementation(() => {
          throw new Error("ENOMEM: Cannot allocate memory");
        });

        const startEvents: Array<{ reason: string }> = [];
        const completeEvents: unknown[] = [];
        orchestrator.on("restart:start", (d) => startEvents.push(d));
        orchestrator.on("restart:complete", (d) => completeEvents.push(d));

        const rollPromise = orchestrator.restartWorkers({ staggerMs: 0, reason: "bail" });
        expect(await settleWithinBudget(rollPromise, 6_000)).toBe("resolved");

        // 3 consecutive failures → the fork environment is unrecoverable
        expect(process.exitCode).toBe(1);
        // A partial roll is not a complete roll
        expect(startEvents).toHaveLength(1);
        expect(completeEvents).toHaveLength(0);
        // The old workers keep serving
        for (const w of Object.values(mockCluster.workers)) {
          expect(w!.isDead()).toBe(false);
        }
      });
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
      expect(tripEvents).toHaveLength(1);
    });

    it("should not trip before the threshold", async () => {
      const { tripEvents } = await setupAndCrash(3, 2);
      expect(tripEvents).toHaveLength(0);
    });

    // The fork-time breaker check drops queued entries: no fork may leak past
    // a trip — capacity is refilled by resetCircuitBreaker() instead.
    it("should not fork queued restarts once the breaker has tripped", async () => {
      vi.useFakeTimers();

      const { orch } = await setupAndCrash(2, 3);

      // The restart queued by the crash that preceded the trip is dropped,
      // not forked past the tripped breaker.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(orch.getMetrics().workerRestarts).toBe(0);

      // After tripping, no additional forks should happen.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(orch.getMetrics().workerRestarts).toBe(0);
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

    // The default logger is null — without a process warning, a minimal setup
    // loses restart capacity with zero output. One warning per trip.
    it("emits a process warning once per trip even without a logger", async () => {
      vi.useFakeTimers();
      const emitWarning = process.emitWarning as unknown as ReturnType<typeof vi.fn>;
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          restart: { crashThreshold: 2, crashWindowMs: 60_000 },
        }),
      );
      await orch.run(() => {});

      // Trip on the 2nd crash, then crash two more times while tripped
      for (let i = 0; i < 4; i++) {
        const all = Object.values(mockCluster.workers);
        mockCluster.emit("exit", all[all.length - 1], 1, null);
      }
      // Let the pre-trip queued restart settle (bounded: runAllTimersAsync
      // would loop forever on the 5-minute crashCleanupInterval)
      await vi.advanceTimersByTimeAsync(2_000);

      expect(emitWarning).toHaveBeenCalledTimes(1);
      expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining("Crash loop"), "ClusterKitCrashLoop");
    });

    it("warns again if the breaker trips a second time after a reset", async () => {
      const emitWarning = process.emitWarning as unknown as ReturnType<typeof vi.fn>;
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          restart: { crashThreshold: 2, crashWindowMs: 60_000 },
        }),
      );
      await orch.run(() => {});

      for (let i = 0; i < 2; i++) {
        const all = Object.values(mockCluster.workers);
        mockCluster.emit("exit", all[all.length - 1], 1, null);
      }
      expect(emitWarning).toHaveBeenCalledTimes(1);

      orch.resetCircuitBreaker();
      for (let i = 0; i < 2; i++) {
        const all = Object.values(mockCluster.workers);
        mockCluster.emit("exit", all[all.length - 1], 1, null);
      }
      expect(emitWarning).toHaveBeenCalledTimes(2);
    });
  });

  // --------------------------------------------------------------------------
  // Exit-code protocol: the primary must not report success (exit 0) when the
  // fleet is unrecoverable. All restart/backoff timers are unref'd, so an
  // empty fleet drains the event loop and the process would otherwise exit
  // with code 0, masking a total crash from supervisors/K8s.
  // --------------------------------------------------------------------------
  describe("exit code protocol", () => {
    // workers must be >= 2 to enter cluster primary mode (workers=1 → single-worker mode)
    async function setupPrimary(workerCount: number | "auto" = 2, extra = {}) {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: workerCount, restart: { backoffMs: 0 }, ...extra }));
      await orch.run(() => {});
      return orch;
    }

    let savedExitCode: typeof process.exitCode;
    beforeEach(() => {
      savedExitCode = process.exitCode;
    });
    afterEach(() => {
      process.exitCode = savedExitCode;
    });

    it("flags exit code 1 when the fleet crashes to empty below the breaker threshold", async () => {
      vi.useFakeTimers();
      const orch = await setupPrimary(2, {
        restart: { backoffMs: 5_000, crashThreshold: 10, crashWindowMs: 60_000 },
      });
      await vi.advanceTimersByTimeAsync(0); // flush initial "online" setImmediates

      // Both workers crash below the threshold: restarts queue behind the
      // unref'd backoff timer, the event loop drains — the process must not
      // report success.
      const fleet = Object.values(mockCluster.workers);
      for (const w of fleet) {
        mockCluster.emit("exit", w, 1, null);
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(orch.getMetrics().activeWorkers).toBe(0);
      expect(orch.getMetrics().workerRestarts).toBe(0); // restarts never forked: the loop drains first
      expect(process.exitCode).toBe(1);
    });

    it("sets exit code 1 on breaker trip and resets it to 0 via resetCircuitBreaker()", async () => {
      const orch = await setupPrimary(2, {
        restart: { backoffMs: 0, crashThreshold: 2, crashWindowMs: 60_000 },
      });

      for (let i = 0; i < 2; i++) {
        const all = Object.values(mockCluster.workers);
        mockCluster.emit("exit", all[all.length - 1], 1, null);
      }
      expect(orch.getHealth().ready).toBe(false);
      expect(process.exitCode).toBe(1);

      orch.resetCircuitBreaker();
      expect(orch.getHealth().ready).toBe(true);
      expect(process.exitCode).toBe(0);

      // Missing capacity is refilled once the breaker is reset
      await new Promise((r) => setImmediate(r));
      expect(orch.getMetrics().activeWorkers).toBe(2);
    });

    it("clears the exit code once the fleet recovers to full capacity", async () => {
      vi.useFakeTimers();
      const orch = await setupPrimary(2, {
        restart: { backoffMs: 100, crashThreshold: 10, crashWindowMs: 60_000 },
      });
      await vi.advanceTimersByTimeAsync(0); // flush initial "online" setImmediates

      // Both workers crash below the threshold — the fleet is down
      const fleet = Object.values(mockCluster.workers);
      for (const w of fleet) {
        mockCluster.emit("exit", w, 1, null);
      }
      expect(process.exitCode).toBe(1);

      // Queued restarts fork replacements, which come online: capacity restored
      await vi.advanceTimersByTimeAsync(1_000);
      expect(orch.getMetrics().activeWorkers).toBe(2);
      expect(process.exitCode).toBe(0);
    });

    it("keeps a graceful shutdown at exit code 0 even after a breaker trip", async () => {
      vi.useFakeTimers();
      const orch = await setupPrimary(2, {
        restart: { backoffMs: 0, crashThreshold: 2, crashWindowMs: 60_000 },
      });
      await vi.advanceTimersByTimeAsync(0); // flush initial "online" setImmediates

      // Trip the breaker: the fleet is unrecoverable
      for (let i = 0; i < 2; i++) {
        const all = Object.values(mockCluster.workers);
        mockCluster.emit("exit", all[all.length - 1], 1, null);
      }
      expect(process.exitCode).toBe(1);

      // An operator-triggered graceful shutdown still exits cleanly
      for (const w of Object.values(mockCluster.workers)) {
        w.autoExitOnDisconnect = true;
      }
      const shutdownPromise = orch.shutdownPrimary("SIGTERM");
      await vi.runAllTimersAsync();
      await shutdownPromise;
      expect(process.exitCode).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  describe("plugin system", () => {
    it("use() returns this for chaining", () => {
      const orch = new Orchestrator(cfg());
      const plugin = { name: "test", install: vi.fn() };
      expect(orch.use(plugin)).toBe(orch);
    });

    // A plugin registered after run() used to be silently ignored but still
    // uninstalled at shutdown — now it throws instead.
    it("use() throws after run() and pre-run plugins still install", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      const install = vi.fn().mockResolvedValue(undefined);
      orch.use({ name: "early", install });
      await orch.run(() => {});
      expect(install).toHaveBeenCalledOnce();

      expect(() => orch.use({ name: "late", install: vi.fn() })).toThrow(
        "use: cannot be called after run() — plugins must be registered before the orchestrator starts",
      );
    });

    it("use() throws after run() even in single-worker mode (no fork)", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 1 }));
      await orch.run(() => {});
      expect(() => orch.use({ name: "late", install: vi.fn() })).toThrow(/after run\(\)/);
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

    // #144: the ordering is unified on the single-worker contract — user
    // callbacks and plugin uninstall run BEFORE shutdown:complete, so a
    // plugin's shutdown:complete listener is not removed by its own
    // uninstall() before the event fires.
    it("emits shutdown:complete after plugin uninstall", async () => {
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
      const order: string[] = [];
      orch.use({
        name: "test",
        install: vi.fn().mockResolvedValue(undefined),
        uninstall: async () => {
          order.push("uninstall");
        },
      });
      await orch.run(() => {});
      orch.on("shutdown:complete", () => order.push("shutdown:complete"));

      const shutdownPromise = orch.shutdownPrimary("SIGTERM");
      await vi.runAllTimersAsync();
      await shutdownPromise;

      expect(order).toEqual(["uninstall", "shutdown:complete"]);
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

    it("enriches a failing install error with the plugin name and rolls back earlier plugins", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      const uninstall = vi.fn();
      orch.use({ name: "good", install: vi.fn().mockResolvedValue(undefined), uninstall });
      orch.use({
        name: "bad",
        install: () => {
          throw new Error("boom");
        },
      });

      const err = await orch.run(() => {}).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("Plugin 'bad' install failed: boom");
      expect(err.cause).toBeInstanceOf(Error);
      expect((err.cause as Error).message).toBe("boom");
      expect(uninstall).toHaveBeenCalledOnce();
    });

    it("enriches the error when the first plugin fails with nothing to roll back", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      const uninstall = vi.fn();
      orch.use({
        name: "bad",
        install: () => {
          throw new Error("boom");
        },
      });

      await expect(orch.run(() => {})).rejects.toThrow("Plugin 'bad' install failed: boom");
      expect(uninstall).not.toHaveBeenCalled();
    });

    it("does not mask the original error when a rollback uninstall fails", async () => {
      mockCluster.isPrimary = true;
      const logError = vi.fn();
      const orch = new Orchestrator(
        cfg({
          workers: 2,
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError },
        }),
      );
      orch.use({
        name: "good",
        install: vi.fn().mockResolvedValue(undefined),
        uninstall: () => {
          throw new Error("rollback exploded");
        },
      });
      orch.use({
        name: "bad",
        install: () => {
          throw new Error("boom");
        },
      });

      const err = await orch.run(() => {}).catch((e) => e);
      expect(err.message).toContain("Plugin 'bad' install failed: boom");
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining("Plugin rollback failed"),
        expect.objectContaining({ plugin: "good", error: "rollback exploded" }),
      );
    });

    it("enriches the error when a plugin throws a non-Error value", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 2 }));
      orch.use({
        name: "bad",
        install: () => {
          throw "boom-string";
        },
      });

      const err = await orch.run(() => {}).catch((e) => e);
      expect(err.message).toContain("Plugin 'bad' install failed: boom-string");
      expect(err.cause).toBe("boom-string");
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

    // any variation of the WEB_CONCURRENCY grammar passed
    // CI. These cases pin the observable parse semantics: parseInt-style
    // prefixing (NOT scientific notation), positivity requirement with CPU
    // fallback, and whitespace tolerance.
    describe("WEB_CONCURRENCY grammar", () => {
      const cpuCount = getCPUCount();

      const cases: Array<{ raw: string; expected: number | "cpu" }> = [
        { raw: "1e3", expected: 1 }, // parseInt("1e3") === 1 — prefix parse, not scientific notation
        { raw: "0", expected: "cpu" }, // zero is rejected → CPU-count fallback
        { raw: "-3", expected: "cpu" }, // negative is rejected → CPU-count fallback
        { raw: "NaN", expected: "cpu" }, // unparseable → CPU-count fallback
        { raw: " 8 ", expected: 8 }, // surrounding whitespace tolerated
      ];

      for (const { raw, expected } of cases) {
        it(`WEB_CONCURRENCY=${JSON.stringify(raw)} → ${expected === "cpu" ? "CPU count fallback" : expected}`, () => {
          const prevWebConcurrency = process.env.WEB_CONCURRENCY;
          process.env.WEB_CONCURRENCY = raw;

          try {
            const orch = new Orchestrator(cfg({ workers: "auto" }));
            expect(orch.workerCount).toBe(expected === "cpu" ? cpuCount : expected);
          } finally {
            if (prevWebConcurrency === undefined) {
              delete process.env.WEB_CONCURRENCY;
            } else {
              process.env.WEB_CONCURRENCY = prevWebConcurrency;
            }
          }
        });
      }
    });

    // An invalid WEB_CONCURRENCY silently falling back to the CPU count is a
    // grammar surprise — it must be visible through the logger facade.
    describe("WEB_CONCURRENCY invalid-value warning", () => {
      function withWebConcurrency(raw: string, fn: () => void) {
        const prevWebConcurrency = process.env.WEB_CONCURRENCY;
        process.env.WEB_CONCURRENCY = raw;
        try {
          fn();
        } finally {
          if (prevWebConcurrency === undefined) {
            delete process.env.WEB_CONCURRENCY;
          } else {
            process.env.WEB_CONCURRENCY = prevWebConcurrency;
          }
        }
      }

      function loggerWithWarnSpy() {
        const warn = vi.fn();
        return { warn, logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } };
      }

      it.each(["0", "-3", "NaN"])("warns once for WEB_CONCURRENCY=%s before falling back to CPU count", (raw) => {
        withWebConcurrency(raw, () => {
          const { warn, logger } = loggerWithWarnSpy();
          const orch = new Orchestrator(cfg({ workers: "auto", logger }));
          expect(orch.workerCount).toBe(getCPUCount());
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn.mock.calls[0][0]).toContain("WEB_CONCURRENCY");
        });
      });

      it("does not warn for valid values (parseInt grammar untouched)", () => {
        withWebConcurrency("1e3", () => {
          const { warn, logger } = loggerWithWarnSpy();
          const orch = new Orchestrator(cfg({ workers: "auto", logger }));
          expect(orch.workerCount).toBe(1); // parseInt("1e3") === 1 — valid, no warning
          expect(warn).not.toHaveBeenCalled();
        });
      });
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
      expect(events).toHaveLength(1);
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
      expect(events).toHaveLength(1); // only one event emitted
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

  // --------------------------------------------------------------------------
  describe("fleet health", () => {
    async function setupPrimary(workerCount: number | "auto" = 2, extra = {}) {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: workerCount, restart: { backoffMs: 0 }, ...extra }));
      await orch.run(() => {});
      return orch;
    }

    it("reports target/active/breaker and stays healthy at capacity", async () => {
      vi.useFakeTimers();
      const o = await setupPrimary(2, {
        shutdown: { timeoutMs: 1_000, ackTimeoutMs: 500, sigtermDelayMs: 300, sigintDelayMs: 200 },
      });
      await vi.advanceTimersByTimeAsync(0); // flush initial "online" setImmediates

      expect(o.getFleetHealth()).toMatchObject({
        target: 2,
        active: 2,
        quarantined: 0,
        breaker: { tripped: false },
      });

      const shutdownPromise = o.shutdownPrimary("SIGTERM");
      await vi.runAllTimersAsync();
      await shutdownPromise;
    });

    it("emits fleet:degraded after the hysteresis and fleet:recovered with duration", async () => {
      vi.useFakeTimers();
      const degraded: unknown[] = [];
      const recovered: unknown[] = [];
      const o = await setupPrimary(2, {
        health: { degradedAfterMs: 1_000 },
        restart: { backoffMs: 2_000 }, // replacement forks after the hysteresis
      });
      o.on("fleet:degraded", (d) => degraded.push(d));
      o.on("fleet:recovered", (d) => recovered.push(d));
      await vi.advanceTimersByTimeAsync(0); // flush initial "online" setImmediates

      // Unclean crash of one worker: capacity drops to 1 of 2 and the
      // replacement fork is delayed past the hysteresis window.
      mockCluster.emit("exit", Object.values(mockCluster.workers)[0], 1, null);

      await vi.advanceTimersByTimeAsync(1_001);
      expect(degraded).toHaveLength(1);
      expect(degraded[0]).toMatchObject({ target: 2, active: 1 });

      // Backoff elapses: replacement forks and comes online — recovered.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ target: 2, active: 2, degradedDurationMs: expect.any(Number) });

      const shutdownPromise = o.shutdownPrimary("SIGTERM");
      await vi.runAllTimersAsync();
      await shutdownPromise;
    });

    it("does not emit degraded during shutdown", async () => {
      vi.useFakeTimers();
      const degraded: unknown[] = [];
      const o = await setupPrimary(2, { health: { degradedAfterMs: 1_000 } });
      o.on("fleet:degraded", (d) => degraded.push(d));
      await vi.advanceTimersByTimeAsync(0); // flush initial "online" setImmediates

      // Drop below target before shutdown: arms the hysteresis timer.
      const workers = Object.values(mockCluster.workers);
      workers[0].exitedAfterDisconnect = true;
      mockCluster.emit("exit", workers[0], 0, null);

      workers[1].autoExitOnDisconnect = true;
      const shutdownPromise = o.shutdownPrimary("SIGTERM");

      // A worker dying mid-shutdown keeps capacity below target — no degraded.
      workers[1].exitedAfterDisconnect = true;
      mockCluster.emit("exit", workers[1], 0, null);

      await vi.runAllTimersAsync();
      await shutdownPromise;

      expect(degraded).toHaveLength(0);
    });
  });
});
