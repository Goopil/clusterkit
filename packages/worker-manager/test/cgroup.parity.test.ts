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

describe("cgroup sync/async cpu parity", () => {
  it("returns the same v2 CPU limit on equivalent inputs", async () => {
    setPlatform("linux");

    mockSyncFiles({
      "/sys/fs/cgroup/cpu.max": "200000 100000",
    });

    mockAsyncFiles({
      "/sys/fs/cgroup/cgroup.controllers": "cpu memory",
      "/sys/fs/cgroup/cpu.max": "200000 100000",
      "/sys/fs/cgroup/memory.max": "268435456",
    });

    const syncCpuLimit = getCgroupCpuLimit();
    const asyncLimits = await readCgroupLimits();

    expect(syncCpuLimit).toBe(2);
    expect(asyncLimits.cpuLimit).toBe(syncCpuLimit);
  });

  it("returns the same v1 CPU limit on equivalent inputs", async () => {
    setPlatform("linux");

    const files = {
      "/proc/self/cgroup": "2:cpu,cpuacct:/kubepods/burstable/pod123/container456",
      "/sys/fs/cgroup/cpu/kubepods/burstable/pod123/container456/cpu.cfs_quota_us": "400000",
      "/sys/fs/cgroup/cpu/kubepods/burstable/pod123/container456/cpu.cfs_period_us": "100000",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "536870912",
    };

    mockSyncFiles(files);
    mockAsyncFiles(files);

    const syncCpuLimit = getCgroupCpuLimit();
    const asyncLimits = await readCgroupLimits();

    expect(syncCpuLimit).toBe(4);
    expect(asyncLimits.cpuLimit).toBe(syncCpuLimit);
  });
});
