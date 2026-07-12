import { describe, expect, it } from "vitest";
import { getCPUCount } from "../src/sizing";

describe("sizing", () => {
  describe("getCPUCount", () => {
    it("should return a positive integer", () => {
      const count = getCPUCount();
      expect(count).toBeGreaterThan(0);
      expect(Number.isInteger(count)).toBe(true);
    });

    it("should return a consistent value across calls", () => {
      expect(getCPUCount()).toBe(getCPUCount());
    });
  });
});
