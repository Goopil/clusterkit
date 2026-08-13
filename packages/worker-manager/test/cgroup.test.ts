import { afterEach, describe, expect, it, vi } from "vitest";

import { getCgroupCpuLimit } from "../src/cgroup";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";

const mockReadFileSync = vi.mocked(readFileSync);

describe("cgroup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getCgroupCpuLimit", () => {
    it("returns null on non-linux platforms", () => {
      vi.stubGlobal("process", { ...process, platform: "darwin" });
      expect(getCgroupCpuLimit()).toBeNull();
      vi.unstubAllGlobals();
    });

    describe("cgroup v2", () => {
      it("reads cpu.max from the resolved v2 process cgroup path", () => {
        vi.stubGlobal("process", { ...process, platform: "linux" });
        mockReadFileSync.mockImplementation((path: unknown) => {
          if (path === "/sys/fs/cgroup/cpu.max") throw new Error("ENOENT");
          if (path === "/proc/self/cgroup") return "0::/kubepods.slice/pod123/container456";
          if (path === "/sys/fs/cgroup/kubepods.slice/pod123/container456/cpu.max") return "300000 100000";
          throw new Error("ENOENT");
        });

        expect(getCgroupCpuLimit()).toBe(3);
        vi.unstubAllGlobals();
      });

      it("parses cpu.max with quota and period", () => {
        vi.stubGlobal("process", { ...process, platform: "linux" });
        mockReadFileSync.mockImplementation((path: unknown) => {
          if (path === "/sys/fs/cgroup/cpu.max") return "200000 100000";
          throw new Error("ENOENT");
        });

        expect(getCgroupCpuLimit()).toBe(2);
        vi.unstubAllGlobals();
      });

      it("returns null when quota is 'max' (unlimited)", () => {
        vi.stubGlobal("process", { ...process, platform: "linux" });
        mockReadFileSync.mockImplementation((path: unknown) => {
          if (path === "/sys/fs/cgroup/cpu.max") return "max 100000";
          throw new Error("ENOENT");
        });

        expect(getCgroupCpuLimit()).toBeNull();
        vi.unstubAllGlobals();
      });

      it("floors to at least 1 CPU", () => {
        vi.stubGlobal("process", { ...process, platform: "linux" });
        mockReadFileSync.mockImplementation((path: unknown) => {
          if (path === "/sys/fs/cgroup/cpu.max") return "50000 100000";
          throw new Error("ENOENT");
        });

        expect(getCgroupCpuLimit()).toBe(1);
        vi.unstubAllGlobals();
      });
    });

    describe("cgroup v1", () => {
      it("reads quota and period from the resolved cpu controller path", () => {
        vi.stubGlobal("process", { ...process, platform: "linux" });
        mockReadFileSync.mockImplementation((path: unknown) => {
          if (path === "/sys/fs/cgroup/cpu.max") throw new Error("ENOENT");
          if (path === "/proc/self/cgroup") return "2:cpu,cpuacct:/kubepods/burstable/pod123/container456";
          if (path === "/sys/fs/cgroup/cpu/kubepods/burstable/pod123/container456/cpu.cfs_quota_us") return "400000";
          if (path === "/sys/fs/cgroup/cpu/kubepods/burstable/pod123/container456/cpu.cfs_period_us") return "100000";
          throw new Error("ENOENT");
        });

        expect(getCgroupCpuLimit()).toBe(4);
        vi.unstubAllGlobals();
      });

      it("parses quota and period files", () => {
        vi.stubGlobal("process", { ...process, platform: "linux" });
        mockReadFileSync.mockImplementation((path: unknown) => {
          if (path === "/sys/fs/cgroup/cpu.max") throw new Error("ENOENT");
          if (path === "/sys/fs/cgroup/cpu/cpu.cfs_quota_us") return "400000";
          if (path === "/sys/fs/cgroup/cpu/cpu.cfs_period_us") return "100000";
          throw new Error("ENOENT");
        });

        expect(getCgroupCpuLimit()).toBe(4);
        vi.unstubAllGlobals();
      });

      it("returns null when quota is -1 (unlimited)", () => {
        vi.stubGlobal("process", { ...process, platform: "linux" });
        mockReadFileSync.mockImplementation((path: unknown) => {
          if (path === "/sys/fs/cgroup/cpu.max") throw new Error("ENOENT");
          if (path === "/sys/fs/cgroup/cpu/cpu.cfs_quota_us") return "-1";
          if (path === "/sys/fs/cgroup/cpu/cpu.cfs_period_us") return "100000";
          throw new Error("ENOENT");
        });

        expect(getCgroupCpuLimit()).toBeNull();
        vi.unstubAllGlobals();
      });
    });

    it("returns null when no cgroup files exist", () => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      expect(getCgroupCpuLimit()).toBeNull();
      vi.unstubAllGlobals();
    });
  });

  describe("cgroup path traversal guard", () => {
    it("rejects cgroup paths containing .. components", () => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (path === "/proc/self/cgroup") return "0::../../etc/passwd";
        if (path === "/sys/etc/passwd/cpu.max") return "100000 100000";
        throw new Error("ENOENT");
      });

      expect(getCgroupCpuLimit()).toBeNull();
      vi.unstubAllGlobals();
    });

    it("rejects cgroup paths with embedded .. in v1 controller path", () => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (path === "/sys/fs/cgroup/cpu.max") throw new Error("ENOENT");
        if (path === "/proc/self/cgroup") return "2:cpu,cpuacct:/../../../etc";
        if (path === "/sys/etc/cpu.cfs_quota_us") return "100000";
        if (path === "/sys/etc/cpu.cfs_period_us") return "100000";
        throw new Error("ENOENT");
      });

      expect(getCgroupCpuLimit()).toBeNull();
      vi.unstubAllGlobals();
    });
  });
});
