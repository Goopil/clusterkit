import { describe, expect, it } from "vitest";
import { createContainerSizingPlugin } from "../src/index.js";

describe("Container sizing plugin integration", () => {
  it("computes sizing from real system resources on the current platform", async () => {
    const plugin = createContainerSizingPlugin();

    // Use a mock orchestrator since we're testing the real readCgroupLimits path
    let patchedCount: number | undefined;
    let patchedEnv: Record<string, string> | undefined;
    const orchestrator = {
      overrideWorkerCount: vi.fn((n: number) => {
        patchedCount = n;
      }),
      patchWorkerEnv: vi.fn((env: Record<string, string>) => {
        patchedEnv = env;
      }),
      on: vi.fn(),
    };
    const config = {
      workers: { count: "auto" as const, env: {} as NodeJS.ProcessEnv },
    };

    await plugin.install(orchestrator as never, null, config as never);

    // On any platform, the plugin should compute a sizing result
    expect(plugin.sizing).toBeDefined();
    expect(plugin.sizing?.workers).toBeGreaterThan(0);
    expect(plugin.sizing?.v8HeapMb).toBeGreaterThanOrEqual(128);

    // On Linux with cgroup limits, count should be overridden
    // On other platforms, fallback to OS resources
    if (process.platform === "linux") {
      expect(patchedCount).toBe(plugin.sizing?.workers);
      expect(patchedEnv?.NODE_OPTIONS).toContain("--max-old-space-size=");
    } else {
      // Fallback mode: still computes from OS resources
      expect(plugin.sizing?.source.cpuLimit).toBeNull();
      expect(plugin.sizing?.source.memoryLimitBytes).toBeNull();
    }
  });
});
