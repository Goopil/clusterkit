import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthMonitor } from "../src/health-monitor";
import type { ResolvedConfig } from "../src/types";

const config: ResolvedConfig = {
  logger: null,
  workers: { count: 2, env: undefined, execArgv: undefined, maxAgeMs: 0, maxRssMb: 0 },
  restart: {
    crashThreshold: 5,
    crashWindowMs: 60_000,
    backoffMs: 0,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2,
    stabilityWindowMs: 0,
    bootFailQuarantine: 0,
  },
  shutdown: { timeoutMs: 1_000, ackTimeoutMs: 500, messagePrefix: "__hm", sigtermDelayMs: 100, sigintDelayMs: 100 },
  health: { heartbeatMs: 0, wedgedTimeoutMs: 0, degradedAfterMs: 10_000 },
  clusterModule: undefined,
};

type MonitorOverrides = {
  health?: Partial<ResolvedConfig["health"]>;
  workers?: Partial<ResolvedConfig["workers"]>;
};

function makeMonitor(overrides: MonitorOverrides = {}, opts: { shuttingDown?: boolean } = {}) {
  const events: Array<{ kind: string; payload: unknown }> = [];
  const monitor = new HealthMonitor(
    {
      ...config,
      health: { ...config.health, ...(overrides.health ?? {}) },
      workers: { ...config.workers, ...(overrides.workers ?? {}) },
    } as ResolvedConfig,
    null,
    {
      isShuttingDown: vi.fn(() => opts.shuttingDown ?? false),
      recycleWorker: (workerId, reason) => events.push({ kind: `recycle:${reason}`, payload: workerId }),
      onHealthReport: (report) => events.push({ kind: "report", payload: report }),
      onWedged: (info) => events.push({ kind: "wedged", payload: info }),
    },
  );
  return { monitor, events };
}

const HB = (extra: Record<string, unknown> = {}) => ({
  type: "__hm:hb",
  rss: 100,
  heapUsed: 50,
  eventLoopLagMs: 1,
  ...extra,
});

describe("HealthMonitor — primary side", () => {
  it("registers valid reports and forwards them", () => {
    const { monitor, events } = makeMonitor();
    monitor.onWorkerMessage(1, 1000, HB());
    expect(events).toContainEqual({
      kind: "report",
      payload: expect.objectContaining({ workerId: 1, pid: 1000, rss: 100 }),
    });
  });

  it("ignores non-health and malformed messages", () => {
    const { monitor, events } = makeMonitor();
    monitor.onWorkerMessage(1, 1000, { type: "__wm:shutdown" });
    monitor.onWorkerMessage(1, 1000, { type: "__hm:hb", rss: "big" });
    monitor.onWorkerMessage(1, 1000, HB({ heapUsed: "big" }));
    monitor.onWorkerMessage(1, 1000, HB({ eventLoopLagMs: "big" }));
    expect(events).toHaveLength(0);
  });

  it("stops forwarding after worker exit", () => {
    const { monitor, events } = makeMonitor();
    monitor.onWorkerMessage(1, 1000, HB());
    monitor.onWorkerExit(1);
    monitor.onWorkerMessage(1, 1000, HB({ rss: 999 }));
    expect(events.filter((e) => e.kind === "report")).toHaveLength(1);
  });
});

describe("HealthMonitor — worker side", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends a report on each beat with computed lag", () => {
    vi.setSystemTime(1_000);
    const send = vi.spyOn(process, "send").mockImplementation(() => true);
    const { monitor } = makeMonitor({ health: { heartbeatMs: 500 } });
    monitor.startWorkerReporting();
    vi.advanceTimersByTime(500); // beat 1, on time
    expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_600); // event loop stalled — wall clock is now 100ms past the next beat's deadline
    vi.advanceTimersByTime(500); // beat 2 fires 100ms late
    expect(send).toHaveBeenCalledTimes(2);
    const second = send.mock.calls[1][0] as Record<string, unknown>;
    expect(second.type).toBe("__hm:hb");
    expect(second.eventLoopLagMs).toBe(100);
    monitor.stopWorkerReporting();
    vi.advanceTimersByTime(2_000);
    expect(send).toHaveBeenCalledTimes(2);
    send.mockRestore();
  });

  it("does not report when heartbeat is disabled", () => {
    const { monitor, events } = makeMonitor();
    monitor.startWorkerReporting(); // heartbeatMs 0 → no-op
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(0);
  });
});

describe("HealthMonitor — policies", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recycles a worker once per instance when RSS exceeds the limit", () => {
    const MB = 1024 * 1024;
    const { monitor, events } = makeMonitor({ workers: { maxRssMb: 1 } });
    const recycleCount = () => events.filter((e) => e.kind === "recycle:rss").length;

    monitor.onWorkerMessage(1, 1000, HB({ rss: 100 })); // below the limit
    expect(recycleCount()).toBe(0);

    monitor.onWorkerMessage(1, 1000, HB({ rss: 2 * MB }));
    expect(recycleCount()).toBe(1);

    monitor.onWorkerMessage(1, 1000, HB({ rss: 3 * MB })); // one-shot per worker instance
    expect(recycleCount()).toBe(1);

    monitor.onWorkerExit(1);
    monitor.onWorkerMessage(1, 1000, HB({ rss: 3 * MB })); // dropped — slot drained after exit
    expect(recycleCount()).toBe(1);
  });

  it("suppresses rss and wedged policies while shutting down", () => {
    const { monitor, events } = makeMonitor(
      { workers: { maxRssMb: 1 }, health: { heartbeatMs: 500, wedgedTimeoutMs: 1_200 } },
      { shuttingDown: true },
    );
    monitor.startWedgedWatch();
    monitor.onWorkerMessage(1, 1000, HB({ rss: 2 * 1024 * 1024 }));
    vi.advanceTimersByTime(5_000);
    expect(events.filter((e) => e.kind.startsWith("recycle:"))).toHaveLength(0);
    expect(events.filter((e) => e.kind === "wedged")).toHaveLength(0);
  });

  it("recycles a wedged worker once and stops watching it", () => {
    vi.setSystemTime(1_000);
    const { monitor, events } = makeMonitor({ health: { heartbeatMs: 500, wedgedTimeoutMs: 1_200 } });
    monitor.startWedgedWatch();
    monitor.onWorkerMessage(1, 1000, HB());
    vi.advanceTimersByTime(1_600); // t=2600: silent for 1500ms > 1200ms
    expect(events.filter((e) => e.kind === "wedged")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "recycle:wedged")).toHaveLength(1);
    vi.advanceTimersByTime(1_000); // no repeat
    expect(events.filter((e) => e.kind === "wedged")).toHaveLength(1);
  });

  it("does not watch for wedged workers when disabled", () => {
    const { monitor, events } = makeMonitor();
    monitor.startWedgedWatch(); // wedgedTimeoutMs 0 → no-op
    monitor.onWorkerMessage(1, 1000, HB());
    vi.advanceTimersByTime(60_000);
    expect(events.filter((e) => e.kind === "wedged")).toHaveLength(0);
  });

  it("stop() halts the wedged watch", () => {
    vi.setSystemTime(1_000);
    const { monitor, events } = makeMonitor({ health: { heartbeatMs: 500, wedgedTimeoutMs: 1_200 } });
    monitor.startWedgedWatch();
    monitor.onWorkerMessage(1, 1000, HB());
    monitor.stop();
    vi.advanceTimersByTime(60_000);
    expect(events.filter((e) => e.kind === "wedged")).toHaveLength(0);
  });
});

describe("HealthMonitor — rss policy", () => {
  it("recycles a worker above maxRssMb, once", () => {
    const { monitor, events } = makeMonitor({ workers: { maxRssMb: 100 } });
    monitor.onWorkerMessage(1, 1000, HB({ rss: 200 * 1024 * 1024 }));
    monitor.onWorkerMessage(1, 1000, HB({ rss: 300 * 1024 * 1024 })); // second report: no double fire
    expect(events.filter((e) => e.kind === "recycle:rss")).toHaveLength(1);
  });

  it("does not recycle below the limit, while shutting down, or when disabled", () => {
    const { monitor, events } = makeMonitor({ workers: { maxRssMb: 100 } });
    monitor.onWorkerMessage(1, 1000, HB({ rss: 50 * 1024 * 1024 }));
    const shutting = makeMonitor({ workers: { maxRssMb: 100 } }, { shuttingDown: true });
    shutting.monitor.onWorkerMessage(1, 1000, HB({ rss: 200 * 1024 * 1024 }));
    const off = makeMonitor();
    off.monitor.onWorkerMessage(1, 1000, HB({ rss: 999 * 1024 * 1024 }));
    expect(events.filter((e) => e.kind.startsWith("recycle:"))).toHaveLength(0);
    expect(shutting.events.filter((e) => e.kind.startsWith("recycle:"))).toHaveLength(0);
    expect(off.events.filter((e) => e.kind.startsWith("recycle:"))).toHaveLength(0);
  });
});
