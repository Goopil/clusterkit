import { beforeEach, describe, expect, it } from "vitest";
import { _resetDetectionCache, detectReusePortSupport, getPlatformCapabilities } from "../src/platform";

describe("platform", () => {
  beforeEach(() => {
    _resetDetectionCache();
  });

  describe("detectReusePortSupport", () => {
    it("should return a boolean", async () => {
      const result = await detectReusePortSupport();
      expect(typeof result).toBe("boolean");
    });

    it("should cache result and return same value on subsequent calls", async () => {
      const result1 = await detectReusePortSupport();
      const result2 = await detectReusePortSupport();
      expect(result1).toBe(result2);
    });

    it("should always return false on Windows", async (ctx) => {
      if (process.platform !== "win32") {
        ctx.skip();
        return;
      }
      const result = await detectReusePortSupport();
      expect(result).toBe(false);
    });

    it("should always return false on macOS (unreliable SO_REUSEPORT)", async (ctx) => {
      if (process.platform !== "darwin") {
        ctx.skip();
        return;
      }
      const result = await detectReusePortSupport();
      expect(result).toBe(false);
    });

    // Runs for real inside the Linux docker test job (compose service `test`)
    it("should always return true on Linux (kernel >= 3.9)", async (ctx) => {
      if (process.platform !== "linux") {
        ctx.skip();
        return;
      }
      const result = await detectReusePortSupport();
      expect(result).toBe(true);
    });

    it("should not throw on any platform", async () => {
      await expect(detectReusePortSupport()).resolves.toBeDefined();
    });

    it("should complete quickly on second call due to caching", async () => {
      await detectReusePortSupport(); // populate cache
      const start = Date.now();
      await detectReusePortSupport();
      expect(Date.now() - start).toBeLessThan(50);
    });

    it("should not run detection twice on concurrent calls before cache is populated", async () => {
      _resetDetectionCache();
      const results = await Promise.all([detectReusePortSupport(), detectReusePortSupport(), detectReusePortSupport()]);
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
    });
  });

  describe("getPlatformCapabilities", () => {
    it("should return object with required fields", async () => {
      const caps = await getPlatformCapabilities();
      expect(caps).toHaveProperty("platform");
      expect(caps).toHaveProperty("reusePort");
    });

    it("should return current platform", async () => {
      const caps = await getPlatformCapabilities();
      expect(caps.platform).toBe(process.platform);
    });

    it("should return a boolean for reusePort", async () => {
      const caps = await getPlatformCapabilities();
      expect(typeof caps.reusePort).toBe("boolean");
    });

    it("should return results consistent with detectReusePortSupport", async () => {
      const reusePort = await detectReusePortSupport();
      const caps = await getPlatformCapabilities();
      expect(caps.reusePort).toBe(reusePort);
    });

    it("should not throw on any platform", async () => {
      await expect(getPlatformCapabilities()).resolves.toBeDefined();
    });
  });
});
