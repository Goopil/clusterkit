import { describe, expect, it, vi } from "vitest";
import { assertSafeEnvObject, validateConfig, WorkerManagerValidationError } from "../src/validation";

describe("validation", () => {
  describe("WorkerManagerValidationError", () => {
    it("should create error with field and message", () => {
      const error = new WorkerManagerValidationError("testField", "test error");
      expect(error.name).toBe("WorkerManagerValidationError");
      expect(error.field).toBe("testField");
      expect(error.message).toBe("Invalid option 'testField': test error");
    });

    it("should be an instance of Error", () => {
      const error = new WorkerManagerValidationError("f", "msg");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("validateConfig — defaults", () => {
    it("should return defaults when called with no args", () => {
      const cfg = validateConfig();
      expect(cfg.workers.count).toBe("auto");
      expect(cfg.workers.maxAgeMs).toBe(0);
      expect(cfg.logger).toBeNull();
      expect(cfg.shutdown.timeoutMs).toBe(12_000);
      expect(cfg.shutdown.messagePrefix).toBe("__wm");
      expect(cfg.shutdown.sigtermDelayMs).toBe(2_000);
      expect(cfg.shutdown.sigintDelayMs).toBe(1_000);
      expect(cfg.restart.crashThreshold).toBe(5);
      expect(cfg.restart.crashWindowMs).toBe(60_000);
      expect(cfg.restart.stabilityWindowMs).toBe(30_000);
    });

    it("should merge provided values over defaults", () => {
      const cfg = validateConfig({ shutdown: { timeoutMs: 5_000 } });
      expect(cfg.shutdown.timeoutMs).toBe(5_000);
      expect(cfg.restart.crashThreshold).toBe(5);
    });

    it("should return same defaults when called with empty object", () => {
      expect(validateConfig({})).toEqual(validateConfig());
    });
  });

  describe("workers block", () => {
    it('should accept workers.count = "auto"', () => {
      expect(() => validateConfig({ workers: { count: "auto" } })).not.toThrow();
    });

    it("should accept workers.count as positive integer", () => {
      expect(() => validateConfig({ workers: { count: 4 } })).not.toThrow();
    });

    it("should reject invalid workers.count", () => {
      expect(() => validateConfig({ workers: { count: 0 } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ workers: { count: -1 } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ workers: { count: 2.5 } })).toThrow(WorkerManagerValidationError);
    });

    it("should validate workers.maxAgeMs", () => {
      expect(() => validateConfig({ workers: { maxAgeMs: 0 } })).not.toThrow();
      expect(() => validateConfig({ workers: { maxAgeMs: 3_600_000 } })).not.toThrow();
      expect(() => validateConfig({ workers: { maxAgeMs: -1_000 } })).toThrow(WorkerManagerValidationError);
    });

    it("should validate workers.env", () => {
      expect(() => validateConfig({ workers: { env: { NODE_ENV: "test" } } })).not.toThrow();
      expect(() => validateConfig({ workers: { env: [] as any } })).toThrow(WorkerManagerValidationError);
    });

    it("should validate workers.execArgv", () => {
      expect(() => validateConfig({ workers: { execArgv: ["--max-old-space-size=512"] } })).not.toThrow();
      expect(() => validateConfig({ workers: { execArgv: [] } })).not.toThrow();
      expect(() => validateConfig({ workers: { execArgv: "--inspect" as any } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ workers: { execArgv: ["--inspect", 42 as any] } })).toThrow(
        WorkerManagerValidationError,
      );
      expect(() => validateConfig({ workers: { execArgv: [""] } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ workers: { execArgv: ["   "] } })).toThrow(WorkerManagerValidationError);
    });

    it("should reject dangerous execArgv flags", () => {
      expect(() => validateConfig({ workers: { execArgv: ["--require=./evil.js"] } })).toThrow(
        WorkerManagerValidationError,
      );
      expect(() => validateConfig({ workers: { execArgv: ["--eval=process.exit()"] } })).toThrow(
        WorkerManagerValidationError,
      );
      expect(() => validateConfig({ workers: { execArgv: ["--inspect"] } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ workers: { execArgv: ["-r", "./evil.js"] } })).toThrow(
        WorkerManagerValidationError,
      );
      expect(() => validateConfig({ workers: { execArgv: ["-e", "process.exit()"] } })).toThrow(
        WorkerManagerValidationError,
      );
    });

    it.each([
      "--import=data:text/javascript,console.log('rce')",
      "--import=./payload.js",
      "--import",
      "--import=x",
      "--experimental-loader=./loader.mjs",
      "--loader=./loader.mjs",
    ])("rejects dangerous execArgv flag %s", (arg) => {
      expect(() => validateConfig({ workers: { execArgv: [arg] } })).toThrow(WorkerManagerValidationError);
    });

    it.each([
      "--tls-keylog=./keylog.txt",
      "--cpu-prof",
      "--heap-prof",
      "--report-on-signal=SIGUSR2",
      "--report-on-fatalerror",
      "--diagnostic-dir=./diagnostics",
      "--redirect-warnings=./warnings.log",
    ])("rejects side-effect execArgv flag %s", (arg) => {
      expect(() => validateConfig({ workers: { execArgv: [arg] } })).toThrow(WorkerManagerValidationError);
    });

    it("should reject dangerous execArgv flags with space separator", () => {
      expect(() => validateConfig({ workers: { execArgv: ["--require ./evil.js"] } })).toThrow(
        WorkerManagerValidationError,
      );
      expect(() => validateConfig({ workers: { execArgv: ["--eval process.exit()"] } })).toThrow(
        WorkerManagerValidationError,
      );
      expect(() => validateConfig({ workers: { execArgv: ["--inspect 9229"] } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ workers: { execArgv: ["--inspect 0.0.0.0:9229"] } })).toThrow(
        WorkerManagerValidationError,
      );
      expect(() => validateConfig({ workers: { execArgv: ["--print 1"] } })).toThrow(WorkerManagerValidationError);
    });

    it("should accept safe execArgv flags", () => {
      expect(() => validateConfig({ workers: { execArgv: ["--max-old-space-size=512"] } })).not.toThrow();
      expect(() => validateConfig({ workers: { execArgv: ["--max-semi-space-size=64"] } })).not.toThrow();
      expect(() => validateConfig({ workers: { execArgv: ["--no-warnings"] } })).not.toThrow();
      expect(() => validateConfig({ workers: { execArgv: ["--expose-gc"] } })).not.toThrow();
      expect(() => validateConfig({ workers: { execArgv: ["--stack-size=1024"] } })).not.toThrow();
    });
  });

  describe("assertSafeEnvObject", () => {
    // JSON.parse defines `__proto__` as a real own enumerable property, which
    // the guard's Object.keys() scan must see. The `__proto__:` literal syntax
    // only sets the prototype instead, so Object.keys() would never list it.
    const polluted = JSON.parse('{"__proto__": "x"}') as Record<string, string>;

    it("rejects __proto__ as an own enumerable key", () => {
      expect(() => assertSafeEnvObject(polluted, "workers.env")).toThrow(WorkerManagerValidationError);
      expect(() => assertSafeEnvObject(polluted, "workers.env")).toThrow(
        "Invalid option 'workers.env': contains forbidden key '__proto__'",
      );
    });

    it("rejects constructor key", () => {
      expect(() => assertSafeEnvObject({ constructor: "x" }, "workers.env")).toThrow(WorkerManagerValidationError);
    });

    it("rejects prototype key", () => {
      expect(() => assertSafeEnvObject({ prototype: "x" }, "workers.env")).toThrow(WorkerManagerValidationError);
    });

    it("accepts clean objects and undefined", () => {
      expect(() => assertSafeEnvObject({ NODE_ENV: "test" }, "workers.env")).not.toThrow();
      expect(() => assertSafeEnvObject(undefined, "workers.env")).not.toThrow();
    });
  });

  describe("validateConfig — workers.env security", () => {
    it("should reject prototype-pollution keys in workers.env", () => {
      expect(() => validateConfig({ workers: { env: JSON.parse('{"__proto__": "x"}') } })).toThrow(
        WorkerManagerValidationError,
      );
      expect(() => validateConfig({ workers: { env: { constructor: "x" } } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ workers: { env: { prototype: "x" } } })).toThrow(WorkerManagerValidationError);
    });

    it("should warn without throwing when workers.env contains NODE_OPTIONS", () => {
      const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      try {
        expect(() => validateConfig({ workers: { env: { NODE_OPTIONS: "--require=./payload.js" } } })).not.toThrow();
        expect(emitWarning).toHaveBeenCalledWith(
          "workers.env contains NODE_OPTIONS — it can bypass execArgv restrictions (--require is allowed in NODE_OPTIONS). Avoid it.",
          "ClusterKitSecurityWarning",
        );
      } finally {
        emitWarning.mockRestore();
      }
    });

    it("should not warn when workers.env has no NODE_OPTIONS", () => {
      const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      try {
        validateConfig({ workers: { env: { NODE_ENV: "test" } } });
        expect(emitWarning).not.toHaveBeenCalled();
      } finally {
        emitWarning.mockRestore();
      }
    });
  });

  describe("restart block", () => {
    it("should validate restart numeric ranges", () => {
      expect(() => validateConfig({ restart: { crashThreshold: 3 } })).not.toThrow();
      expect(() => validateConfig({ restart: { crashWindowMs: 30_000 } })).not.toThrow();
      expect(() => validateConfig({ restart: { stabilityWindowMs: 0 } })).not.toThrow();
      expect(() =>
        validateConfig({ restart: { backoffMs: 500, maxBackoffMs: 1_000, backoffMultiplier: 2 } }),
      ).not.toThrow();
    });

    it("should reject invalid restart values", () => {
      expect(() => validateConfig({ restart: { crashThreshold: 0 } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ restart: { crashWindowMs: 500 } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ restart: { stabilityWindowMs: -1 } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ restart: { maxBackoffMs: 500 } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ restart: { backoffMultiplier: 0.5 } })).toThrow(WorkerManagerValidationError);
    });

    it("should reject restart.backoffMs > restart.maxBackoffMs", () => {
      expect(() => validateConfig({ restart: { backoffMs: 2_000, maxBackoffMs: 1_000 } })).toThrow(
        WorkerManagerValidationError,
      );
    });
  });

  describe("shutdown block", () => {
    it("should validate shutdown ranges and message prefix", () => {
      expect(() =>
        validateConfig({
          shutdown: {
            timeoutMs: 4_000,
            ackTimeoutMs: 1_000,
            sigtermDelayMs: 1_000,
            sigintDelayMs: 500,
            messagePrefix: "myapp",
          },
        }),
      ).not.toThrow();
    });

    it("should reject invalid shutdown values", () => {
      expect(() => validateConfig({ shutdown: { timeoutMs: 500 } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ shutdown: { ackTimeoutMs: 100 } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ shutdown: { sigtermDelayMs: 50 } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ shutdown: { sigintDelayMs: 15_000 } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ shutdown: { messagePrefix: "my:app" } })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ shutdown: { messagePrefix: "" } })).toThrow(WorkerManagerValidationError);
    });

    it("should reject inconsistent shutdown timings", () => {
      expect(() =>
        validateConfig({
          shutdown: { timeoutMs: 1_000, ackTimeoutMs: 1_000 },
        }),
      ).toThrow(WorkerManagerValidationError);

      expect(() =>
        validateConfig({
          shutdown: { timeoutMs: 1_000, sigtermDelayMs: 600, sigintDelayMs: 500 },
        }),
      ).toThrow(WorkerManagerValidationError);
    });
  });

  describe("shape guards", () => {
    it("should reject non-object blocks", () => {
      expect(() => validateConfig({ workers: [] as any })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ restart: null as any })).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ shutdown: 42 as any })).toThrow(WorkerManagerValidationError);
    });

    it("should reject unsupported root options", () => {
      expect(() => validateConfig({ foo: "bar" } as any)).toThrow(WorkerManagerValidationError);
    });

    it("should reject legacy flat options", () => {
      expect(() => validateConfig({ workers: 4 } as any)).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ workerEnv: { NODE_ENV: "test" } } as any)).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ restartBackoffMs: 1_000 } as any)).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ shutdownTimeoutMs: 5_000 } as any)).toThrow(WorkerManagerValidationError);
      expect(() => validateConfig({ messagePrefix: "myapp" } as any)).toThrow(WorkerManagerValidationError);
    });
  });
});
