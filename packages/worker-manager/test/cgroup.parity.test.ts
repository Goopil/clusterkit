import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCgroupCpuLimit, readCgroupLimits } from "../src/cgroup";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockReadFile = vi.mocked(readFile);

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function mockSyncFiles(files: Record<string, string>): void {
  mockReadFileSync.mockImplementation((requestedPath: unknown) => {
    if (typeof requestedPath === "string" && requestedPath in files) {
      return files[requestedPath];
    }

    throw new Error("ENOENT");
  });
}

function mockAsyncFiles(files: Record<string, string>): void {
  mockReadFile.mockImplementation(((requestedPath: string) => {
    if (requestedPath in files) {
      return Promise.resolve(files[requestedPath]);
    }

    return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  }) as typeof readFile);
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.resetAllMocks();
});

const cases = [
  {
    name: "reads canonical v2 limits",
    files: {
      "/sys/fs/cgroup/cgroup.controllers": "cpu memory",
      "/sys/fs/cgroup/cpu.max": "200000 100000",
      "/sys/fs/cgroup/memory.max": "268435456",
    },
    expectedSyncCpu: 2,
    expectedAsync: { cpuLimit: 2, memoryLimitBytes: 268435456 },
  },
  {
    name: "reads resolved v2 paths and preserves fractional CPU limits asynchronously",
    files: {
      "/sys/fs/cgroup/cgroup.controllers": "cpu memory",
      "/proc/self/cgroup": "0::/kubepods.slice/pod123/container456",
      "/sys/fs/cgroup/kubepods.slice/pod123/container456/cpu.max": "150000 100000",
      "/sys/fs/cgroup/kubepods.slice/pod123/container456/memory.max": "536870912",
    },
    expectedSyncCpu: 1,
    expectedAsync: { cpuLimit: 1.5, memoryLimitBytes: 536870912 },
  },
  {
    name: "handles unlimited v2 CPU and memory",
    files: {
      "/sys/fs/cgroup/cgroup.controllers": "cpu memory",
      "/sys/fs/cgroup/cpu.max": "max 100000",
      "/sys/fs/cgroup/memory.max": "max",
    },
    expectedSyncCpu: null,
    expectedAsync: { cpuLimit: null, memoryLimitBytes: null },
  },
  {
    name: "reads resolved v1 paths",
    files: {
      "/proc/self/cgroup": [
        "2:cpu,cpuacct:/kubepods/burstable/pod123/container456",
        "5:memory:/kubepods/burstable/pod123/container456",
      ].join("\n"),
      "/sys/fs/cgroup/cpu/kubepods/burstable/pod123/container456/cpu.cfs_quota_us": "400000",
      "/sys/fs/cgroup/cpu/kubepods/burstable/pod123/container456/cpu.cfs_period_us": "100000",
      "/sys/fs/cgroup/memory/kubepods/burstable/pod123/container456/memory.limit_in_bytes": "536870912",
    },
    expectedSyncCpu: 4,
    expectedAsync: { cpuLimit: 4, memoryLimitBytes: 536870912 },
  },
  {
    name: "handles unlimited v1 CPU and memory",
    files: {
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1",
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
    },
    expectedSyncCpu: null,
    expectedAsync: { cpuLimit: null, memoryLimitBytes: null },
  },
  {
    name: "returns null limits when cgroup files are absent",
    files: {},
    expectedSyncCpu: null,
    expectedAsync: { cpuLimit: null, memoryLimitBytes: null },
  },
] as const;

describe("cgroup sync/async contract", () => {
  it.each(cases)("$name", async ({ files, expectedSyncCpu, expectedAsync }) => {
    setPlatform("linux");
    mockSyncFiles(files);
    mockAsyncFiles(files);

    expect(getCgroupCpuLimit()).toBe(expectedSyncCpu);
    await expect(readCgroupLimits()).resolves.toEqual(expectedAsync);
  });
});
