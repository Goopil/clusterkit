import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createContainerSizingPlugin } from "../src/index.js";

vi.mock("@goopil/clusterkit", async (importOriginal) => {
  return {
    ...((await importOriginal()) as any),
    readCgroupLimits: vi.fn(),
  };
});
vi.mock("node:cluster", () => ({ default: { isPrimary: true } }));

const { readCgroupLimits } = await import("@goopil/clusterkit");
const mockReadCgroupLimits = vi.mocked(readCgroupLimits);

const MB = 1024 * 1024;

function makeOrchestrator(workers: number | "auto" = "auto") {
  let configuredWorkers = workers;
  const patchWorkerEnv = vi.fn();
  const overrideWorkerCount = vi.fn((n: number) => {
    configuredWorkers = n;
  });

  const orchestrator = {
    get configuredWorkers() {
      return configuredWorkers;
    },
    patchWorkerEnv,
    overrideWorkerCount,
    on: vi.fn(),
  };

  const config = {
    workers: {
      count: workers,
      env: {} as NodeJS.ProcessEnv,
    },
  };

  return { orchestrator, config };
}

const nullLogger = null;

beforeEach(() => {
  mockReadCgroupLimits.mockResolvedValue({ cpuLimit: 2, memoryLimitBytes: 512 * MB });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createContainerSizingPlugin", () => {
  it("returns a plugin with the correct name", () => {
    const plugin = createContainerSizingPlugin();
    expect(plugin.name).toBe("container-sizing");
  });

  it("sizing is undefined before install", () => {
    const plugin = createContainerSizingPlugin();
    expect(plugin.sizing).toBeUndefined();
  });

  it("computes sizing and patches orchestrator on install", async () => {
    const plugin = createContainerSizingPlugin();
    const { orchestrator, config } = makeOrchestrator("auto");

    await plugin.install(orchestrator as never, nullLogger, config);

    expect(plugin.sizing).toBeDefined();
    expect(plugin.sizing!.workers).toBe(2);
    expect(orchestrator.overrideWorkerCount).toHaveBeenCalledWith(2);
    expect(orchestrator.patchWorkerEnv).toHaveBeenCalledWith(
      expect.objectContaining({ NODE_OPTIONS: expect.stringContaining("--max-old-space-size=") }),
    );
  });

  it("does not override worker count when orchestrator has explicit config", async () => {
    const plugin = createContainerSizingPlugin();
    const { orchestrator, config } = makeOrchestrator(4); // explicit number

    await plugin.install(orchestrator as never, nullLogger, config);

    expect(orchestrator.overrideWorkerCount).not.toHaveBeenCalled();
    // Still injects NODE_OPTIONS
    expect(orchestrator.patchWorkerEnv).toHaveBeenCalled();
  });

  it("skips NODE_OPTIONS injection when injectNodeOptions is false", async () => {
    const plugin = createContainerSizingPlugin({ injectNodeOptions: false });
    const { orchestrator, config } = makeOrchestrator();

    await plugin.install(orchestrator as never, nullLogger, config);

    expect(orchestrator.patchWorkerEnv).not.toHaveBeenCalled();
    expect(plugin.sizing).toBeDefined();
  });

  it("skips worker count override when overrideWorkerCount is false", async () => {
    const plugin = createContainerSizingPlugin({ overrideWorkerCount: false });
    const { orchestrator, config } = makeOrchestrator();

    await plugin.install(orchestrator as never, nullLogger, config);

    expect(orchestrator.overrideWorkerCount).not.toHaveBeenCalled();
    // Still injects NODE_OPTIONS
    expect(orchestrator.patchWorkerEnv).toHaveBeenCalled();
  });

  describe("fallback behaviour", () => {
    beforeEach(() => {
      mockReadCgroupLimits.mockResolvedValue({ cpuLimit: null, memoryLimitBytes: null });
    });

    it("applies OS resources when fallback=true (default)", async () => {
      const plugin = createContainerSizingPlugin();
      const { orchestrator, config } = makeOrchestrator();

      await plugin.install(orchestrator as never, nullLogger, config);

      expect(plugin.sizing).toBeDefined();
      expect(orchestrator.overrideWorkerCount).toHaveBeenCalled();
    });

    it("is a no-op when fallback=false and no container limits detected", async () => {
      const plugin = createContainerSizingPlugin({ fallback: false });
      const { orchestrator, config } = makeOrchestrator();

      await plugin.install(orchestrator as never, nullLogger, config);

      expect(plugin.sizing).toBeUndefined();
      expect(orchestrator.overrideWorkerCount).not.toHaveBeenCalled();
      expect(orchestrator.patchWorkerEnv).not.toHaveBeenCalled();
    });

    it("still validates sizing options when fallback=false and no container limits are detected", async () => {
      const plugin = createContainerSizingPlugin({ fallback: false, maxWorkers: 257 });
      const { orchestrator, config } = makeOrchestrator();

      await expect(plugin.install(orchestrator as never, nullLogger, config)).rejects.toThrow(/maxWorkers/);
    });
  });

  it("preserves existing NODE_OPTIONS set in workerEnv config", async () => {
    const plugin = createContainerSizingPlugin();
    const { orchestrator, config } = makeOrchestrator();
    // Simulate user having set workers.env.NODE_OPTIONS in OrchestratorConfig
    config.workers.env = { NODE_OPTIONS: "--no-warnings" };

    await plugin.install(orchestrator as never, nullLogger, config);

    const call = vi.mocked(orchestrator.patchWorkerEnv).mock.calls[0][0] as Record<string, string>;
    expect(call.NODE_OPTIONS).toContain("--max-old-space-size=");
    expect(call.NODE_OPTIONS).toContain("--no-warnings");
  });

  it("appends extraNodeOptions to the injected NODE_OPTIONS", async () => {
    const plugin = createContainerSizingPlugin({ extraNodeOptions: "--expose-gc" });
    const { orchestrator, config } = makeOrchestrator();

    await plugin.install(orchestrator as never, nullLogger, config);

    const call = vi.mocked(orchestrator.patchWorkerEnv).mock.calls[0][0] as Record<string, string>;
    expect(call.NODE_OPTIONS).toContain("--expose-gc");
  });

  it("does nothing on worker processes (cluster.isPrimary = false)", async () => {
    const clusterMod = await import("node:cluster");
    const originalIsPrimary = clusterMod.default.isPrimary;
    Object.defineProperty(clusterMod.default, "isPrimary", { value: false, configurable: true });

    const plugin = createContainerSizingPlugin();
    const { orchestrator, config } = makeOrchestrator();

    await plugin.install(orchestrator as never, nullLogger, config);

    expect(plugin.sizing).toBeUndefined();
    expect(orchestrator.overrideWorkerCount).not.toHaveBeenCalled();
    expect(orchestrator.patchWorkerEnv).not.toHaveBeenCalled();

    Object.defineProperty(clusterMod.default, "isPrimary", { value: originalIsPrimary, configurable: true });
  });
});
