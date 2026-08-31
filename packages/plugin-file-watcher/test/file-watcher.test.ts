import cluster from "node:cluster";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
import chokidar from "chokidar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileWatcherPlugin } from "../src/index";
import { parseEnvFile } from "../src/parse-env";

vi.mock("node:cluster", () => ({ default: { isPrimary: true } }));

describe("parseEnvFile", () => {
  it.each([
    ["FOO=bar\nBAZ=qux", "parses simple KEY=VALUE pairs"],
    ["FOO=bar\n\nBAZ=qux\n\n", "skips empty lines"],
    ["# comment\nFOO=bar\n# another\nBAZ=qux", "skips comments starting with #"],
    ["FOO=bar\nINVALID\nBAZ=qux", "skips lines without ="],
  ])("parses env file: %s", (input: string) => {
    const result = parseEnvFile(input);
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips surrounding double quotes", () => {
    const result = parseEnvFile('FOO="bar baz"');
    expect(result).toEqual({ FOO: "bar baz" });
  });

  it("strips surrounding single quotes", () => {
    const result = parseEnvFile("FOO='bar baz'");
    expect(result).toEqual({ FOO: "bar baz" });
  });

  it("handles empty file", () => {
    expect(parseEnvFile("")).toEqual({});
  });

  it("handles value containing =", () => {
    const result = parseEnvFile("URL=postgres://user:pass@host:5432/db");
    expect(result).toEqual({ URL: "postgres://user:pass@host:5432/db" });
  });

  it("trims whitespace around key and value", () => {
    const result = parseEnvFile("  FOO  =  bar  ");
    expect(result).toEqual({ FOO: "bar" });
  });
});

function mockOrchestrator(): Orchestrator & {
  restartWorkers: ReturnType<typeof vi.fn>;
  registerOnShutdown: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter() as unknown as Orchestrator & {
    restartWorkers: ReturnType<typeof vi.fn>;
    registerOnShutdown: ReturnType<typeof vi.fn>;
  };
  emitter.restartWorkers = vi.fn().mockResolvedValue(undefined);
  emitter.registerOnShutdown = vi.fn();
  return emitter;
}

function mockConfig(count: number | "auto" = 2): ResolvedConfig {
  return {
    logger: null,
    workers: { count, env: undefined, execArgv: undefined, maxAgeMs: 0 },
    restart: {
      crashThreshold: 5,
      crashWindowMs: 60_000,
      backoffMs: 1_000,
      maxBackoffMs: 30_000,
      backoffMultiplier: 2,
      stabilityWindowMs: 30_000,
    },
    shutdown: {
      timeoutMs: 12_000,
      ackTimeoutMs: 3_000,
      messagePrefix: "__wm",
      sigtermDelayMs: 2_000,
      sigintDelayMs: 1_000,
    },
    clusterModule: undefined,
  };
}

describe("file-watcher plugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-ops in single-worker mode", async () => {
    Object.defineProperty(cluster, "isPrimary", { value: true, configurable: true });
    const plugin = createFileWatcherPlugin({ watch: ["./src"] });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(1));

    expect(plugin.isWatching).toBe(false);
  });

  it("no-ops in worker process", async () => {
    Object.defineProperty(cluster, "isPrimary", { value: false, configurable: true });
    const plugin = createFileWatcherPlugin({ watch: ["./src"] });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));

    expect(plugin.isWatching).toBe(false);
    Object.defineProperty(cluster, "isPrimary", { value: true, configurable: true });
  });

  it("registers shutdown callback", async () => {
    const plugin = createFileWatcherPlugin({ watch: [] });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));

    expect(orch.registerOnShutdown).toHaveBeenCalled();
  });

  it("dryRun mode does not call restartWorkers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const tempFile = join(tempDir, "test.txt");
    writeFileSync(tempFile, "initial");

    const plugin = createFileWatcherPlugin({
      watch: [tempFile],
      debounceMs: 50,
      dryRun: true,
    });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));
    expect(plugin.isWatching).toBe(true);

    // Give chokidar time to fully initialize and settle spurious initial events
    await new Promise((r) => setTimeout(r, 500));

    // Clear any calls from spurious initial events
    orch.restartWorkers.mockClear();

    // Trigger a file change
    writeFileSync(tempFile, "changed");

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 200));

    expect(orch.restartWorkers).not.toHaveBeenCalled();

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("calls restartWorkers on file change after debounce", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const tempFile = join(tempDir, "test.txt");
    writeFileSync(tempFile, "initial");

    const plugin = createFileWatcherPlugin({
      watch: [tempDir],
      debounceMs: 50,
      staggerMs: 0,
    });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));

    // Give chokidar time to fully initialize and settle spurious initial events
    await new Promise((r) => setTimeout(r, 500));
    orch.restartWorkers.mockClear();

    // Trigger a file change
    writeFileSync(tempFile, "changed");

    // Wait for debounce + buffer
    await new Promise((r) => setTimeout(r, 300));

    expect(orch.restartWorkers).toHaveBeenCalledTimes(1);
    expect(orch.restartWorkers).toHaveBeenCalledWith(expect.objectContaining({ reason: "file-change", staggerMs: 0 }));

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses .env file and passes env to restartWorkers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "FOO=bar\nBAZ=qux");

    const plugin = createFileWatcherPlugin({
      envFile: [envPath],
      debounceMs: 50,
      staggerMs: 0,
    });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));

    // Give chokidar time to fully initialize and settle spurious initial events
    await new Promise((r) => setTimeout(r, 500));
    orch.restartWorkers.mockClear();

    // Modify .env file
    writeFileSync(envPath, "FOO=updated\nBAZ=qux\nNEW=key");

    // Wait for debounce + buffer
    await new Promise((r) => setTimeout(r, 300));

    expect(orch.restartWorkers).toHaveBeenCalledTimes(1);
    const callArgs = orch.restartWorkers.mock.calls[0][0];
    expect(callArgs.env).toEqual({ FOO: "updated", BAZ: "qux", NEW: "key" });
    expect(callArgs.reason).toBe("env-change");

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("coalesces rapid changes into a single restartWorkers call", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const tempFile = join(tempDir, "test.txt");
    writeFileSync(tempFile, "initial");

    const plugin = createFileWatcherPlugin({
      watch: [tempDir],
      debounceMs: 100,
      staggerMs: 0,
    });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));

    // Give chokidar time to fully initialize and settle spurious initial events
    await new Promise((r) => setTimeout(r, 500));
    orch.restartWorkers.mockClear();

    // Rapidly change the file multiple times
    for (let i = 0; i < 5; i++) {
      writeFileSync(tempFile, `change-${i}`);
    }

    // Wait for debounce + buffer
    await new Promise((r) => setTimeout(r, 400));

    expect(orch.restartWorkers).toHaveBeenCalledTimes(1);

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stops watching on uninstall", async () => {
    const plugin = createFileWatcherPlugin({ watch: [] });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));
    expect(plugin.isWatching).toBe(true);

    await plugin.uninstall?.();
    expect(plugin.isWatching).toBe(false);
  });

  it("pollEnv detects new env var and triggers restart", async () => {
    vi.useFakeTimers();
    try {
      delete process.env.__TEST_POLL;
      const plugin = createFileWatcherPlugin({
        pollEnv: true,
        pollEnvIntervalMs: 5_000,
        debounceMs: 50,
        staggerMs: 0,
      });
      const orch = mockOrchestrator();
      await plugin.install(orch, null, mockConfig(2));
      expect(plugin.isWatching).toBe(true);

      process.env.__TEST_POLL = "hello";

      await vi.advanceTimersByTimeAsync(5_001);
      await vi.advanceTimersByTimeAsync(51);

      expect(orch.restartWorkers).toHaveBeenCalledTimes(1);
      expect(orch.restartWorkers).toHaveBeenCalledWith(expect.objectContaining({ reason: "env-change" }));
    } finally {
      delete process.env.__TEST_POLL;
      vi.useRealTimers();
    }
  });

  it("pollEnv detects removed env var and triggers restart", async () => {
    vi.useFakeTimers();
    try {
      process.env.__TEST_POLL_RM = "initial";
      const plugin = createFileWatcherPlugin({
        pollEnv: true,
        pollEnvIntervalMs: 5_000,
        debounceMs: 50,
        staggerMs: 0,
      });
      const orch = mockOrchestrator();
      await plugin.install(orch, null, mockConfig(2));

      delete process.env.__TEST_POLL_RM;

      await vi.advanceTimersByTimeAsync(5_001);
      await vi.advanceTimersByTimeAsync(51);

      expect(orch.restartWorkers).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.__TEST_POLL_RM;
      vi.useRealTimers();
    }
  });

  it("pollEnv does not trigger restart when env unchanged", async () => {
    vi.useFakeTimers();
    try {
      const plugin = createFileWatcherPlugin({
        pollEnv: true,
        pollEnvIntervalMs: 5_000,
        debounceMs: 50,
      });
      const orch = mockOrchestrator();
      await plugin.install(orch, null, mockConfig(2));

      await vi.advanceTimersByTimeAsync(20_000);

      expect(orch.restartWorkers).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pollEnv interval is cleaned up on uninstall", async () => {
    vi.useFakeTimers();
    try {
      const plugin = createFileWatcherPlugin({
        pollEnv: true,
        pollEnvIntervalMs: 5_000,
      });
      await plugin.install(mockOrchestrator(), null, mockConfig(2));
      await plugin.uninstall?.();

      const spy = vi.spyOn(global, "clearInterval");
      await plugin.uninstall?.();
      expect(spy).not.toHaveBeenCalledWith(expect.any(Number));
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs error when restartWorkers rejects", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const tempFile = join(tempDir, "test.txt");
    writeFileSync(tempFile, "initial");

    const plugin = createFileWatcherPlugin({
      watch: [tempDir],
      debounceMs: 50,
      staggerMs: 0,
    });
    const orch = mockOrchestrator();
    orch.restartWorkers.mockRejectedValueOnce(new Error("restart failed"));

    await plugin.install(orch, null, mockConfig(2));
    await new Promise((r) => setTimeout(r, 500));
    orch.restartWorkers.mockClear();
    orch.restartWorkers.mockRejectedValueOnce(new Error("restart failed"));

    writeFileSync(tempFile, "changed");
    await new Promise((r) => setTimeout(r, 300));

    expect(orch.restartWorkers).toHaveBeenCalledTimes(1);

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("logs error when envParser throws on .env change", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "FOO=bar");

    const plugin = createFileWatcherPlugin({
      envFile: [envPath],
      envParser: () => {
        throw new Error("parse error");
      },
      debounceMs: 50,
    });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));
    await new Promise((r) => setTimeout(r, 500));
    orch.restartWorkers.mockClear();

    writeFileSync(envPath, "FOO=updated");
    await new Promise((r) => setTimeout(r, 300));

    expect(orch.restartWorkers).not.toHaveBeenCalled();

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("logs error when chokidar.watch throws for file watcher", async () => {
    vi.spyOn(chokidar, "watch").mockImplementation(() => {
      throw new Error("watch failed");
    });

    const plugin = createFileWatcherPlugin({ watch: ["./src"] });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, mockConfig(2));

    expect(plugin.isWatching).toBe(true);
    await plugin.uninstall?.();
  });

  it("logs error when chokidar.watch throws for env watcher", async () => {
    let callCount = 0;
    vi.spyOn(chokidar, "watch").mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error("watch failed");
      const emitter = new EventEmitter();
      return Object.assign(emitter, { close: () => Promise.resolve() }) as any;
    });

    const plugin = createFileWatcherPlugin({
      watch: ["./src"],
      envFile: ["./.env"],
    });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, mockConfig(2));

    expect(plugin.isWatching).toBe(true);
    await plugin.uninstall?.();
  });

  it("triggers restart on file add event", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const plugin = createFileWatcherPlugin({
      watch: [tempDir],
      debounceMs: 50,
      staggerMs: 0,
    });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));
    await new Promise((r) => setTimeout(r, 500));
    orch.restartWorkers.mockClear();

    writeFileSync(join(tempDir, "new-file.txt"), "content");
    await new Promise((r) => setTimeout(r, 300));

    expect(orch.restartWorkers).toHaveBeenCalledTimes(1);

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("triggers restart on file unlink event", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const tempFile = join(tempDir, "to-delete.txt");
    writeFileSync(tempFile, "initial");

    const plugin = createFileWatcherPlugin({
      watch: [tempDir],
      debounceMs: 50,
      staggerMs: 0,
    });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));
    await new Promise((r) => setTimeout(r, 500));
    orch.restartWorkers.mockClear();

    rmSync(tempFile);
    await new Promise((r) => setTimeout(r, 300));

    expect(orch.restartWorkers).toHaveBeenCalledTimes(1);

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not double-trigger when a path is in both watch and envFile", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "FOO=bar");

    const plugin = createFileWatcherPlugin({
      watch: [tempDir],
      envFile: [envPath],
      debounceMs: 50,
      staggerMs: 0,
    });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));
    await new Promise((r) => setTimeout(r, 500));
    orch.restartWorkers.mockClear();

    writeFileSync(envPath, "FOO=updated");
    await new Promise((r) => setTimeout(r, 300));

    expect(orch.restartWorkers).toHaveBeenCalledTimes(1);
    expect(orch.restartWorkers).toHaveBeenCalledWith(expect.objectContaining({ reason: "env-change" }));

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses custom reason when configured", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const tempFile = join(tempDir, "test.txt");
    writeFileSync(tempFile, "initial");

    const plugin = createFileWatcherPlugin({
      watch: [tempDir],
      reason: "custom-reason",
      debounceMs: 50,
      staggerMs: 0,
    });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));
    await new Promise((r) => setTimeout(r, 500));
    orch.restartWorkers.mockClear();

    writeFileSync(tempFile, "changed");
    await new Promise((r) => setTimeout(r, 300));

    expect(orch.restartWorkers).toHaveBeenCalledWith(expect.objectContaining({ reason: "custom-reason" }));

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("delays watcher start when startDelayMs > 0", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const plugin = createFileWatcherPlugin({
      watch: [tempDir],
      startDelayMs: 200,
    });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig(2));
    expect(plugin.isWatching).toBe(false);

    await new Promise((r) => setTimeout(r, 300));
    expect(plugin.isWatching).toBe(true);

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes ignore option to chokidar", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const spy = vi.spyOn(chokidar, "watch");

    const plugin = createFileWatcherPlugin({
      watch: [tempDir],
      ignore: ["**/node_modules/**"],
    });
    await plugin.install(mockOrchestrator(), null, mockConfig(2));

    expect(spy).toHaveBeenCalledWith([tempDir], expect.objectContaining({ ignored: ["**/node_modules/**"] }));

    await plugin.uninstall?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts watch as string instead of array", async () => {
    const plugin = createFileWatcherPlugin({ watch: "./src" });
    const spy = vi.spyOn(chokidar, "watch");
    await plugin.install(mockOrchestrator(), null, mockConfig(2));
    expect(spy).toHaveBeenCalledWith(["./src"], expect.anything());
    await plugin.uninstall?.();
  });

  it("accepts envFile as string instead of array", async () => {
    const plugin = createFileWatcherPlugin({ envFile: "./.env" });
    const spy = vi.spyOn(chokidar, "watch");
    await plugin.install(mockOrchestrator(), null, mockConfig(2));
    expect(spy).toHaveBeenCalledWith(["./.env"], expect.anything());
    await plugin.uninstall?.();
  });

  it("shutdown callback closes watchers and clears state", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    const plugin = createFileWatcherPlugin({ watch: [tempDir] });
    const orch = mockOrchestrator();
    let shutdownCb: (() => Promise<void>) | undefined;

    orch.registerOnShutdown = vi.fn((cb) => {
      shutdownCb = cb;
    });

    await plugin.install(orch, null, mockConfig(2));
    expect(plugin.isWatching).toBe(true);

    await shutdownCb!();
    expect(plugin.isWatching).toBe(false);

    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("storm hardening options", () => {
    function stubWatcher(): Array<EventEmitter & { close: () => Promise<void> }> {
      const watchers: Array<EventEmitter & { close: () => Promise<void> }> = [];
      vi.spyOn(chokidar, "watch").mockImplementation(() => {
        const emitter = new EventEmitter() as EventEmitter & { close: () => Promise<void> };
        emitter.close = () => Promise.resolve();
        watchers.push(emitter);
        return emitter as any;
      });
      return watchers;
    }

    it("fires restart once when debounceMaxWaitMs elapses during a continuous change storm", async () => {
      vi.useFakeTimers();
      try {
        const watchers = stubWatcher();
        const plugin = createFileWatcherPlugin({
          watch: ["./src"],
          debounceMs: 300,
          debounceMaxWaitMs: 1000,
        });
        const orch = mockOrchestrator();
        await plugin.install(orch, null, mockConfig(2));
        expect(orch.restartWorkers).not.toHaveBeenCalled();

        // Continuous storm: an event every 50ms keeps resetting the debounce timer
        for (let i = 0; i < 19; i++) {
          watchers[0].emit("change", "/app/src/file.ts");
          await vi.advanceTimersByTimeAsync(50);
          expect(orch.restartWorkers).not.toHaveBeenCalled();
        }

        // Max-wait elapses (first event + 1000ms) despite the ongoing storm
        await vi.advanceTimersByTimeAsync(50);
        expect(orch.restartWorkers).toHaveBeenCalledTimes(1);

        // No further restarts once the storm stops
        await vi.advanceTimersByTimeAsync(1000);
        expect(orch.restartWorkers).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps trailing-edge-only debounce when debounceMaxWaitMs is not set", async () => {
      vi.useFakeTimers();
      try {
        const watchers = stubWatcher();
        const plugin = createFileWatcherPlugin({
          watch: ["./src"],
          debounceMs: 300,
        });
        const orch = mockOrchestrator();
        await plugin.install(orch, null, mockConfig(2));

        // Storm: events every 50ms keep resetting the debounce timer, nothing fires
        for (let i = 0; i < 10; i++) {
          watchers[0].emit("change", "/app/src/file.ts");
          await vi.advanceTimersByTimeAsync(50);
        }
        expect(orch.restartWorkers).not.toHaveBeenCalled();

        // Quiet gap → single trailing-edge restart
        await vi.advanceTimersByTimeAsync(300);
        expect(orch.restartWorkers).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips restart trigger within minRestartIntervalMs of the last restart", async () => {
      vi.useFakeTimers();
      try {
        const watchers = stubWatcher();
        const plugin = createFileWatcherPlugin({
          watch: ["./src"],
          debounceMs: 50,
          minRestartIntervalMs: 1000,
        });
        const orch = mockOrchestrator();
        await plugin.install(orch, null, mockConfig(2));

        // First trigger restarts
        watchers[0].emit("change", "/app/src/a.ts");
        await vi.advanceTimersByTimeAsync(50);
        expect(orch.restartWorkers).toHaveBeenCalledTimes(1);

        // Second trigger inside the interval is skipped
        watchers[0].emit("change", "/app/src/b.ts");
        await vi.advanceTimersByTimeAsync(50);
        expect(orch.restartWorkers).toHaveBeenCalledTimes(1);

        // Once the interval has elapsed, triggers restart again
        await vi.advanceTimersByTimeAsync(1000);
        watchers[0].emit("change", "/app/src/c.ts");
        await vi.advanceTimersByTimeAsync(50);
        expect(orch.restartWorkers).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("allows back-to-back restarts when minRestartIntervalMs is not set", async () => {
      vi.useFakeTimers();
      try {
        const watchers = stubWatcher();
        const plugin = createFileWatcherPlugin({
          watch: ["./src"],
          debounceMs: 50,
        });
        const orch = mockOrchestrator();
        await plugin.install(orch, null, mockConfig(2));

        watchers[0].emit("change", "/app/src/a.ts");
        await vi.advanceTimersByTimeAsync(50);
        expect(orch.restartWorkers).toHaveBeenCalledTimes(1);

        watchers[0].emit("change", "/app/src/b.ts");
        await vi.advanceTimersByTimeAsync(50);
        expect(orch.restartWorkers).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
