import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCgroupLimits } from "../src/cgroup";

vi.mock("node:fs/promises");

const mockReadFile = vi.mocked(readFile);

function mockFiles(files: Record<string, string>): void {
  mockReadFile.mockImplementation(((path: string) => {
    if (path in files) return Promise.resolve(files[path]);
    return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  }) as typeof readFile);
}

const originalPlatform = process.platform;

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.resetAllMocks();
});

describe("readCgroupLimits", () => {
  describe("non-Linux", () => {
    beforeEach(() => setPlatform("darwin"));

    it("returns null for both limits", async () => {
      const result = await readCgroupLimits();
      expect(result).toEqual({ cpuLimit: null, memoryLimitBytes: null });
      expect(mockReadFile).not.toHaveBeenCalled();
    });
  });

  describe("cgroup v2", () => {
    beforeEach(() => setPlatform("linux"));

    it("reads CPU and memory from the resolved v2 process cgroup path", async () => {
      mockFiles({
        "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu memory",
        "/proc/self/cgroup": "0::/kubepods.slice/pod123/container456",
        "/sys/fs/cgroup/kubepods.slice/pod123/container456/cpu.max": "250000 100000",
        "/sys/fs/cgroup/kubepods.slice/pod123/container456/memory.max": "536870912",
      });
      const result = await readCgroupLimits();
      expect(result.cpuLimit).toBe(2.5);
      expect(result.memoryLimitBytes).toBe(536870912);
    });

    it("falls back to canonical v2 paths when the resolved path is unreadable", async () => {
      mockFiles({
        "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu memory",
        "/proc/self/cgroup": "0::/kubepods.slice/pod123/container456",
        "/sys/fs/cgroup/cpu.max": "200000 100000",
        "/sys/fs/cgroup/memory.max": "268435456",
      });
      const result = await readCgroupLimits();
      expect(result.cpuLimit).toBe(2.0);
      expect(result.memoryLimitBytes).toBe(268435456);
    });

    it("reads CPU and memory limits", async () => {
      mockFiles({
        "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory hugetlb pids rdma",
        "/sys/fs/cgroup/cpu.max": "200000 100000",
        "/sys/fs/cgroup/memory.max": "536870912",
      });
      const result = await readCgroupLimits();
      expect(result.cpuLimit).toBe(2.0);
      expect(result.memoryLimitBytes).toBe(536870912);
    });

    it("returns fractional cpuLimit", async () => {
      mockFiles({
        "/sys/fs/cgroup/cgroup.controllers": "cpu memory",
        "/sys/fs/cgroup/cpu.max": "150000 100000",
        "/sys/fs/cgroup/memory.max": "268435456",
      });
      const result = await readCgroupLimits();
      expect(result.cpuLimit).toBe(1.5);
    });

    it("returns null cpuLimit when cpu.max is 'max'", async () => {
      mockFiles({
        "/sys/fs/cgroup/cgroup.controllers": "cpu memory",
        "/sys/fs/cgroup/cpu.max": "max 100000",
        "/sys/fs/cgroup/memory.max": "268435456",
      });
      const result = await readCgroupLimits();
      expect(result.cpuLimit).toBeNull();
      expect(result.memoryLimitBytes).toBe(268435456);
    });

    it("returns null memoryLimitBytes when memory.max is 'max'", async () => {
      mockFiles({
        "/sys/fs/cgroup/cgroup.controllers": "cpu memory",
        "/sys/fs/cgroup/cpu.max": "200000 100000",
        "/sys/fs/cgroup/memory.max": "max",
      });
      const result = await readCgroupLimits();
      expect(result.cpuLimit).toBe(2.0);
      expect(result.memoryLimitBytes).toBeNull();
    });

    it("returns both null when files are missing", async () => {
      mockFiles({
        "/sys/fs/cgroup/cgroup.controllers": "cpu memory",
      });
      const result = await readCgroupLimits();
      expect(result).toEqual({ cpuLimit: null, memoryLimitBytes: null });
    });
  });

  describe("cgroup v1", () => {
    beforeEach(() => setPlatform("linux"));

    it("reads CPU and memory from controller-specific resolved v1 paths", async () => {
      mockFiles({
        "/proc/self/cgroup": [
          "2:cpu,cpuacct:/kubepods/burstable/pod123/container456",
          "5:memory:/kubepods/burstable/pod123/container456",
        ].join("\n"),
        "/sys/fs/cgroup/cpu/kubepods/burstable/pod123/container456/cpu.cfs_quota_us": "200000",
        "/sys/fs/cgroup/cpu/kubepods/burstable/pod123/container456/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/memory/kubepods/burstable/pod123/container456/memory.limit_in_bytes": "536870912",
      });
      const result = await readCgroupLimits();
      expect(result.cpuLimit).toBe(2.0);
      expect(result.memoryLimitBytes).toBe(536870912);
    });

    it("reads CPU and memory limits", async () => {
      // No cgroup.controllers → v1
      mockFiles({
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "536870912",
      });
      const result = await readCgroupLimits();
      expect(result.cpuLimit).toBe(2.0);
      expect(result.memoryLimitBytes).toBe(536870912);
    });

    it("returns null cpuLimit when quota is -1", async () => {
      mockFiles({
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "268435456",
      });
      const result = await readCgroupLimits();
      expect(result.cpuLimit).toBeNull();
      expect(result.memoryLimitBytes).toBe(268435456);
    });

    it("returns null memoryLimitBytes when at v1 unlimited sentinel", async () => {
      mockFiles({
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
        // cgroupv1 unlimited sentinel value
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
      });
      const result = await readCgroupLimits();
      expect(result.cpuLimit).toBe(2.0);
      expect(result.memoryLimitBytes).toBeNull();
    });

    it("returns both null when no cgroup files exist", async () => {
      mockFiles({});
      const result = await readCgroupLimits();
      expect(result).toEqual({ cpuLimit: null, memoryLimitBytes: null });
    });
  });
});
