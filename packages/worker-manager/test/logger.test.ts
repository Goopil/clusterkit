import { describe, expect, it, vi } from "vitest";
import { createConsoleLogger, withLoggerPrefix } from "../src/logger";

describe("logger", () => {
  describe("createConsoleLogger", () => {
    it("should return an object with all Logger methods", () => {
      const logger = createConsoleLogger();
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
    });

    it("should call console.info for info()", () => {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      const logger = createConsoleLogger();
      logger.info("hello");
      expect(spy).toHaveBeenCalledWith("hello");
      spy.mockRestore();
    });

    it("should call console.warn for warn()", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logger = createConsoleLogger();
      logger.warn("warning");
      expect(spy).toHaveBeenCalledWith("warning");
      spy.mockRestore();
    });

    it("should call console.error for error()", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = createConsoleLogger();
      logger.error("err");
      expect(spy).toHaveBeenCalledWith("err");
      spy.mockRestore();
    });

    it("should call console.debug for debug()", () => {
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const logger = createConsoleLogger();
      logger.debug("dbg");
      expect(spy).toHaveBeenCalledWith("dbg");
      spy.mockRestore();
    });

    it("should append JSON-stringified data when provided", () => {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      const logger = createConsoleLogger();
      logger.info("msg", { key: "value" });
      expect(spy).toHaveBeenCalledWith('msg {"key":"value"}');
      spy.mockRestore();
    });

    it("should not throw when called without data", () => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const logger = createConsoleLogger();
      expect(() => logger.info("msg")).not.toThrow();
      vi.restoreAllMocks();
    });

    it("should not throw for any log level without data", () => {
      vi.spyOn(console, "debug").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = createConsoleLogger();
      expect(() => {
        logger.debug("d");
        logger.info("i");
        logger.warn("w");
        logger.error("e");
      }).not.toThrow();
      vi.restoreAllMocks();
    });
  });

  describe("withLoggerPrefix", () => {
    it("should prefix info messages", () => {
      const info = vi.fn();
      const logger = {
        debug: vi.fn(),
        info,
        warn: vi.fn(),
        error: vi.fn(),
      };

      const prefixed = withLoggerPrefix(logger, "clusterkit:test");
      prefixed?.info("hello", { scope: "x" });

      expect(info).toHaveBeenCalledWith("[clusterkit:test] hello", { scope: "x" });
    });

    it("should return null when logger is null", () => {
      expect(withLoggerPrefix(null, "clusterkit:test")).toBeNull();
    });

    it("should return original logger when prefix is empty", () => {
      const logger = createConsoleLogger();
      expect(withLoggerPrefix(logger, "   ")).toBe(logger);
    });
  });
});
