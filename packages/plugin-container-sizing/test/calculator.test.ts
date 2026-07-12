import { describe, expect, it } from "vitest";
import { calculateSizing, mergeNodeOptions } from "../src/calculator.js";
import type { CgroupLimits } from "../src/cgroup.js";

const MB = 1024 * 1024;

describe("calculateSizing", () => {
  it("rejects memoryOverheadFactor outside the (0, 1] range", () => {
    const limits: CgroupLimits = { cpuLimit: 2, memoryLimitBytes: 512 * MB };
    expect(() => calculateSizing(limits, { memoryOverheadFactor: 0 })).toThrow();
    expect(() => calculateSizing(limits, { memoryOverheadFactor: 1.1 })).toThrow();
  });

  it("rejects heapRatio outside the (0, 1] range", () => {
    const limits: CgroupLimits = { cpuLimit: 2, memoryLimitBytes: 512 * MB };
    expect(() => calculateSizing(limits, { heapRatio: 0 })).toThrow();
    expect(() => calculateSizing(limits, { heapRatio: 1.5 })).toThrow();
  });

  it("rejects invalid worker bounds", () => {
    const limits: CgroupLimits = { cpuLimit: 2, memoryLimitBytes: 512 * MB };
    expect(() => calculateSizing(limits, { minWorkers: 0 })).toThrow();
    expect(() => calculateSizing(limits, { maxWorkers: 0 })).toThrow();
    expect(() => calculateSizing(limits, { minWorkers: 4, maxWorkers: 2 })).toThrow();
  });

  it("rejects unrealistic worker bounds", () => {
    const limits: CgroupLimits = { cpuLimit: 2, memoryLimitBytes: 512 * MB };
    expect(() => calculateSizing(limits, { minWorkers: 257 })).toThrow();
    expect(() => calculateSizing(limits, { maxWorkers: 257 })).toThrow();
  });

  it("computes workers, heap and nodeOptions from container limits", () => {
    const limits: CgroupLimits = { cpuLimit: 2.0, memoryLimitBytes: 512 * MB };
    const result = calculateSizing(limits);

    expect(result.workers).toBe(2);
    // 512MB * 0.80 / 2 = 204MB per worker
    expect(result.memoryPerWorkerMb).toBe(204);
    // 204MB * 0.75 = 153MB heap
    expect(result.v8HeapMb).toBe(153);
    expect(result.nodeOptions).toBe("--max-old-space-size=153");
  });

  it("floors fractional cpu to integer workers", () => {
    const limits: CgroupLimits = { cpuLimit: 1.5, memoryLimitBytes: 512 * MB };
    const result = calculateSizing(limits);
    expect(result.workers).toBe(1);
  });

  it("falls back to os resources when limits are null", () => {
    const limits: CgroupLimits = { cpuLimit: null, memoryLimitBytes: null };
    const result = calculateSizing(limits);
    // Workers must be at least 1 and match os.cpus().length (clamped to maxWorkers)
    expect(result.workers).toBeGreaterThanOrEqual(1);
    expect(result.v8HeapMb).toBeGreaterThan(0);
    expect(result.source.cpuLimit).toBeNull();
    expect(result.source.memoryLimitBytes).toBeNull();
  });

  it("clamps workers to minWorkers", () => {
    const limits: CgroupLimits = { cpuLimit: 0.5, memoryLimitBytes: 512 * MB };
    const result = calculateSizing(limits, { minWorkers: 2 });
    expect(result.workers).toBe(2);
  });

  it("clamps workers to maxWorkers", () => {
    const limits: CgroupLimits = { cpuLimit: 128, memoryLimitBytes: 64 * 1024 * MB };
    const result = calculateSizing(limits, { maxWorkers: 8 });
    expect(result.workers).toBe(8);
  });

  it("memory-first strategy reduces workers when heap would be too small", () => {
    // 256MB total, 4 CPUs → 256*0.8/4 = 51MB per worker → 51*0.75 = 38MB heap < 128MB threshold
    // should step down to 1 worker → 256*0.8/1 = 204MB → 153MB heap ≥ 128MB
    const limits: CgroupLimits = { cpuLimit: 4, memoryLimitBytes: 256 * MB };
    const result = calculateSizing(limits, { strategy: "memory-first" });
    expect(result.workers).toBe(1);
    expect(result.v8HeapMb).toBeGreaterThanOrEqual(128);
  });

  it("memory-first strategy does not go below minWorkers", () => {
    // Very small memory, minWorkers=2 — should stay at 2 even if heap < 128MB
    const limits: CgroupLimits = { cpuLimit: 4, memoryLimitBytes: 64 * MB };
    const result = calculateSizing(limits, { strategy: "memory-first", minWorkers: 2 });
    expect(result.workers).toBe(2);
  });

  it("cpu-first strategy uses floor(cpu) workers", () => {
    const limits: CgroupLimits = { cpuLimit: 3.9, memoryLimitBytes: 2048 * MB };
    const result = calculateSizing(limits, { strategy: "cpu-first" });
    expect(result.workers).toBe(3);
  });

  it("balanced strategy (default) also reduces workers when heap would be too small", () => {
    // 8 CPUs but only 256MB — the default strategy must not compute 8 non-viable workers
    const limits: CgroupLimits = { cpuLimit: 8, memoryLimitBytes: 256 * MB };
    const result = calculateSizing(limits);
    expect(result.workers).toBe(1);
    expect(result.v8HeapMb).toBeGreaterThanOrEqual(128);
    expect(result.constrained).toBe(false);
  });

  it("never emits a sub-viable --max-old-space-size (cpu-first, tiny memory)", () => {
    // 64 CPUs and 128MB would compute heap ≈ 0; 0 disables the V8 limit entirely
    const limits: CgroupLimits = { cpuLimit: 64, memoryLimitBytes: 128 * MB };
    const result = calculateSizing(limits, { strategy: "cpu-first", maxWorkers: 64 });
    expect(result.v8HeapMb).toBeGreaterThanOrEqual(128);
    expect(result.constrained).toBe(true);
    expect(result.nodeOptions).toBe(`--max-old-space-size=${result.v8HeapMb}`);
  });

  it("flags constrained when minWorkers forces a sub-viable heap", () => {
    const limits: CgroupLimits = { cpuLimit: 4, memoryLimitBytes: 64 * MB };
    const result = calculateSizing(limits, { minWorkers: 2 });
    expect(result.workers).toBe(2);
    expect(result.constrained).toBe(true);
    expect(result.v8HeapMb).toBe(128);
  });

  it("exposes source details", () => {
    const limits: CgroupLimits = { cpuLimit: 2, memoryLimitBytes: 512 * MB };
    const result = calculateSizing(limits);
    expect(result.source.cpuLimit).toBe(2);
    expect(result.source.memoryLimitBytes).toBe(512 * MB);
    expect(result.source.osCpus).toBeGreaterThan(0);
    expect(result.source.osTotalMemoryBytes).toBeGreaterThan(0);
  });
});

describe("mergeNodeOptions", () => {
  it("returns the computed option when nothing else is set", () => {
    expect(mergeNodeOptions("--max-old-space-size=512", "")).toBe("--max-old-space-size=512");
  });

  it("replaces an existing --max-old-space-size", () => {
    const result = mergeNodeOptions("--max-old-space-size=512", "--max-old-space-size=256 --no-warnings");
    expect(result).toContain("--max-old-space-size=512");
    expect(result).not.toContain("--max-old-space-size=256");
    expect(result).toContain("--no-warnings");
  });

  it("preserves unrelated existing options", () => {
    const result = mergeNodeOptions("--max-old-space-size=512", "--no-warnings --experimental-vm-modules");
    expect(result).toContain("--no-warnings");
    expect(result).toContain("--experimental-vm-modules");
  });

  it("appends extra options", () => {
    const result = mergeNodeOptions("--max-old-space-size=512", "", "--expose-gc");
    expect(result).toBe("--max-old-space-size=512 --expose-gc");
  });

  it("produces no double spaces when existing is empty", () => {
    const result = mergeNodeOptions("--max-old-space-size=512", "");
    expect(result).toBe("--max-old-space-size=512");
    expect(result).not.toContain("  ");
  });

  it("replaces the underscore spelling --max_old_space_size", () => {
    const result = mergeNodeOptions("--max-old-space-size=512", "--max_old_space_size=8192 --no-warnings");
    expect(result).toContain("--max-old-space-size=512");
    expect(result).not.toContain("8192");
    expect(result).toContain("--no-warnings");
  });

  it("replaces the space-separated form --max-old-space-size N", () => {
    const result = mergeNodeOptions("--max-old-space-size=512", "--max-old-space-size 8192 --no-warnings");
    expect(result).toContain("--max-old-space-size=512");
    expect(result).not.toContain("8192");
    expect(result).toContain("--no-warnings");
  });
});
