# Worker Health & Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in worker-health subsystem to `@goopil/clusterkit` (heartbeat, RSS recycling, wedged-worker kill, boot-loop quarantine, fleet health surface) plus prometheus metrics, a `compileCache` option, a recovery benchmark and a Linux e2e chaos suite.

**Architecture:** New internal service `src/health-monitor.ts` (worker-side reporter + primary-side registry/policies) wired by the Orchestrator through typed deps — the same coordinator pattern as `restart-coordinator.ts`/`drain-coordinator.ts`. Internal modules never emit; the Orchestrator owns every public event. All recycles (`maxAge`, `rss`, `wedged`) funnel through the existing bounded drain. Spec: `docs/superpowers/specs/2026-09-04-worker-health-recovery-design.md`.

**Tech Stack:** TypeScript, Node.js `node:cluster`, vitest (fake timers), prom-client (plugin), tsdown/turborepo, biome.

## Global Constraints

- Load nvm before ANY command: `source ~/.nvm/nvm.sh && nvm use` (reads `.nvmrc`, Node ≥ 22.12).
- Package manager: `corepack pnpm`, never bare `pnpm`.
- No new runtime dependencies in `@goopil/clusterkit` (devDeps/peerDeps only). All code, comments and docs in English.
- All new features opt-in, defaults off (`health.heartbeatMs: 0`, `health.wedgedTimeoutMs: 0`, `workers.maxRssMb: 0`, `restart.bootFailQuarantine: 0`). Existing suite stays green untouched.
- Events rise for observability, calls cross for control: internal modules receive deps, never emit.
- Logger prefix pattern: `clusterkit:health-monitor`.
- Tests live in `packages/worker-manager/test/`, vitest globals enabled. `workers: 1` is single-worker mode; crash/restart behavior needs `workers >= 2`.
- Every commit leaves the package suite green: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit test`.
- Each task ships its README section and a changeset when user-facing.

---

### Task 1: Config, types and validation for health options

**Files:**
- Modify: `packages/worker-manager/src/types.ts`
- Modify: `packages/worker-manager/src/validation.ts`
- Modify: `packages/worker-manager/src/index.ts`
- Test: `packages/worker-manager/test/validation.test.ts`

**Interfaces:**
- Produces (consumed by every later task):
  - `HealthConfig` `{ heartbeatMs?: number; wedgedTimeoutMs?: number; degradedAfterMs?: number }`
  - `WorkersConfig.maxRssMb?: number`, `RestartConfig.bootFailQuarantine?: number`
  - `ResolvedConfig` gains `health: { heartbeatMs: number; wedgedTimeoutMs: number; degradedAfterMs: number }`, `workers.maxRssMb: number`, `restart.bootFailQuarantine: number`
  - `RecycleReason = "maxAge" | "rss" | "wedged"`, `WorkerHealthReport`, `FleetHealth`
  - `OrchestratorEvents` gains `worker:health`, `worker:wedged`, `worker:quarantined`, `fleet:degraded`, `fleet:recovered`; `worker:recycle` payload gains `reason: RecycleReason`

- [ ] **Step 1: Write failing validation tests** (append inside the root `describe` of `test/validation.test.ts`)

```ts
describe("health options", () => {
  it("defaults everything off", () => {
    const resolved = validateConfig({});
    expect(resolved.health).toEqual({ heartbeatMs: 0, wedgedTimeoutMs: 0, degradedAfterMs: 10_000 });
    expect(resolved.workers.maxRssMb).toBe(0);
    expect(resolved.restart.bootFailQuarantine).toBe(0);
  });

  it("accepts a valid health config and rss/quarantine options", () => {
    expect(() =>
      validateConfig({
        health: { heartbeatMs: 5_000, wedgedTimeoutMs: 15_000, degradedAfterMs: 2_000 },
        workers: { maxRssMb: 512 },
        restart: { bootFailQuarantine: 3 },
      }),
    ).not.toThrow();
  });

  it("rejects wedgedTimeoutMs without heartbeatMs", () => {
    expect(() => validateConfig({ health: { wedgedTimeoutMs: 15_000 } })).toThrow(WorkerManagerValidationError);
  });

  it("rejects wedgedTimeoutMs < 2 × heartbeatMs", () => {
    expect(() => validateConfig({ health: { heartbeatMs: 5_000, wedgedTimeoutMs: 9_000 } })).toThrow(
      WorkerManagerValidationError,
    );
  });

  it("rejects non-positive or tiny heartbeatMs", () => {
    expect(() => validateConfig({ health: { heartbeatMs: 50 } })).toThrow(WorkerManagerValidationError);
  });

  it("rejects negative maxRssMb and bootFailQuarantine", () => {
    expect(() => validateConfig({ workers: { maxRssMb: -1 } })).toThrow(WorkerManagerValidationError);
    expect(() => validateConfig({ restart: { bootFailQuarantine: -1 } })).toThrow(WorkerManagerValidationError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter @goopil/clusterkit exec vitest run test/validation.test.ts`
Expected: FAIL — `resolved.health` is `undefined`.

- [ ] **Step 3: Implement types** — in `src/types.ts`:

```ts
// In WorkersConfig, after maxAgeMs:
  /** Recycle a worker whose RSS exceeds this value in MB. Uses the graceful drain. 0 = disabled. @default 0 */
  maxRssMb?: number;

// In RestartConfig, after stabilityWindowMs:
  /** Consecutive crashes before the worker's first online that quarantine the slot
   * (stop re-forking it while other workers serve). 0 = disabled. @default 0 */
  bootFailQuarantine?: number;

// New root config block after ShutdownConfig:
export interface HealthConfig {
  /** Worker health report (RSS, heap, event-loop lag) interval in ms. 0 = disabled. @default 0 */
  heartbeatMs?: number;
  /** Recycle a worker whose heartbeat has been silent this long. Requires heartbeatMs > 0
   * and >= 2 × heartbeatMs. 0 = disabled. @default 0 */
  wedgedTimeoutMs?: number;
  /** Duration `active < target` must persist before `fleet:degraded` fires. @default 10_000 */
  degradedAfterMs?: number;
}

// OrchestratorConfig gains:  /** Worker health monitoring options. */
//   health?: HealthConfig;

export type RecycleReason = "maxAge" | "rss" | "wedged";

export interface WorkerHealthReport {
  workerId: number;
  pid: number;
  rss: number;
  heapUsed: number;
  eventLoopLagMs: number;
}

export interface FleetHealth {
  target: number;
  active: number;
  quarantined: number;
  breaker: { count: number; tripped: boolean };
}

// ResolvedConfig: workers gains `maxRssMb: number`, restart gains `bootFailQuarantine: number`,
// and a new resolved block `health: { heartbeatMs: number; wedgedTimeoutMs: number; degradedAfterMs: number }`.

// OrchestratorEvents — replace the worker:recycle line and append:
  "worker:recycle": [data: { workerId: number; pid: number; ageMs: number; reason: RecycleReason }];
  "worker:health": [data: WorkerHealthReport];
  "worker:wedged": [data: { workerId: number; pid: number; silentMs: number }];
  "worker:quarantined": [data: { consecutiveBootFailures: number }];
  "fleet:degraded": [data: { target: number; active: number }];
  "fleet:recovered": [data: { target: number; active: number; degradedDurationMs: number }];
```

- [ ] **Step 4: Implement validation** — in `src/validation.ts`:

```ts
// New validator (mirror validateShutdownOptions style):
function validateHealthOptions(health: HealthConfig): void {
  if (health.heartbeatMs !== undefined) {
    if (!Number.isInteger(health.heartbeatMs) || health.heartbeatMs < 0) {
      throw new WorkerManagerValidationError("health.heartbeatMs", "must be a non-negative integer");
    }
    if (health.heartbeatMs > 0 && health.heartbeatMs < 100) {
      throw new WorkerManagerValidationError("health.heartbeatMs", "must be >= 100 when enabled (IPC protection)");
    }
  }
  if (health.wedgedTimeoutMs !== undefined) {
    if (!Number.isInteger(health.wedgedTimeoutMs) || health.wedgedTimeoutMs < 0) {
      throw new WorkerManagerValidationError("health.wedgedTimeoutMs", "must be a non-negative integer");
    }
  }
  if (health.degradedAfterMs !== undefined) {
    if (!Number.isInteger(health.degradedAfterMs) || health.degradedAfterMs <= 0) {
      throw new WorkerManagerValidationError("health.degradedAfterMs", "must be a positive integer");
    }
  }
}

// In validateWorkersOptions (maxAge pattern): maxRssMb must be an integer >= 0.
// In validateRestartOptions: bootFailQuarantine must be an integer >= 0.

// In validateCrossFieldConstraints (new block):
  if ((resolved.health.wedgedTimeoutMs ?? 0) > 0) {
    if ((resolved.health.heartbeatMs ?? 0) <= 0) {
      throw new WorkerManagerValidationError("health.wedgedTimeoutMs", "requires health.heartbeatMs > 0");
    }
    if (resolved.health.wedgedTimeoutMs < 2 * resolved.health.heartbeatMs) {
      throw new WorkerManagerValidationError(
        "health.wedgedTimeoutMs",
        `must be >= 2 × health.heartbeatMs (${resolved.health.heartbeatMs}ms)`,
      );
    }
  }

// DEFAULTS: workers.maxRssMb: 0, restart.bootFailQuarantine: 0,
// health: { heartbeatMs: 0, wedgedTimeoutMs: 0, degradedAfterMs: 10_000 }
// ALLOWED_ROOT_KEYS gains "health".
// validateConfig(): validateHealthOptions(config.health ?? {}); resolve `health` and the two new
// fields into resolvedConfig (plain `?? DEFAULTS` mapping).
```

- [ ] **Step 5: Export new types from `src/index.ts`** — add to the type export list: `FleetHealth, HealthConfig, RecycleReason, WorkerHealthReport`.

- [ ] **Step 6: Run tests → green, then commit**

Run: `corepack pnpm --filter @goopil/clusterkit exec vitest run test/validation.test.ts` then the full package suite.
Expected: PASS (all).

```bash
git add -A && git commit -m "feat(core): health config surface (heartbeat, maxRssMb, bootFailQuarantine)"
```

---

### Task 2: `HealthMonitor` module — heartbeat + IPC routing

**Files:**
- Create: `packages/worker-manager/src/health-monitor.ts`
- Modify: `packages/worker-manager/src/worker-manager.ts` (message tap)
- Modify: `packages/worker-manager/src/orchestrator.ts` (wiring)
- Modify: `packages/worker-manager/vitest.config.ts` (coverage floor)
- Test: `packages/worker-manager/test/health-monitor.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig` (with `health` from Task 1), `WorkerHealthReport`, `isTypedMessage`.
- Produces: `HealthMonitor`, `HealthMonitorDeps` exported from `src/health-monitor.ts`:
  - `constructor(cfg: ResolvedConfig, log: Logger | null, deps: HealthMonitorDeps)`
  - `HealthMonitorDeps = { isShuttingDown(): boolean; recycleWorker(workerId: number, reason: "rss" | "wedged"): void; onHealthReport(report: WorkerHealthReport): void; onWedged(info: { workerId: number; pid: number; silentMs: number }): void }`
  - `startWorkerReporting(): void` / `stopWorkerReporting(): void` (worker side)
  - `onWorkerMessage(workerId: number, pid: number, msg: unknown): void` (primary side)
  - `startWedgedWatch(): void` (primary side; no-op when `wedgedTimeoutMs <= 0`)
  - `onWorkerExit(workerId: number): void`, `stop(): void`

- [ ] **Step 1: Write failing unit tests** — `test/health-monitor.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthMonitor } from "../src/health-monitor";
import type { ResolvedConfig } from "../src/types";

const config: ResolvedConfig = {
  logger: null,
  workers: { count: 2, env: undefined, execArgv: undefined, maxAgeMs: 0, maxRssMb: 0 },
  restart: { crashThreshold: 5, crashWindowMs: 60_000, backoffMs: 0, maxBackoffMs: 30_000, backoffMultiplier: 2, stabilityWindowMs: 0, bootFailQuarantine: 0 },
  shutdown: { timeoutMs: 1_000, ackTimeoutMs: 500, messagePrefix: "__hm", sigtermDelayMs: 100, sigintDelayMs: 100 },
  health: { heartbeatMs: 0, wedgedTimeoutMs: 0, degradedAfterMs: 10_000 },
  clusterModule: undefined,
};

function makeMonitor(overrides: Partial<ResolvedConfig["health"] & ResolvedConfig["workers"]> = {}) {
  const events: Array<{ kind: string; payload: unknown }> = [];
  const monitor = new HealthMonitor(
    { ...config, health: { ...config.health, ...(overrides.health ?? {}) }, workers: { ...config.workers, ...(overrides.workers ?? {}) } } as ResolvedConfig,
    null,
    {
      isShuttingDown: vi.fn(() => false),
      recycleWorker: (workerId, reason) => events.push({ kind: `recycle:${reason}`, payload: workerId }),
      onHealthReport: (report) => events.push({ kind: "report", payload: report }),
      onWedged: (info) => events.push({ kind: "wedged", payload: info }),
    },
  );
  return { monitor, events };
}

const HB = (extra: Record<string, unknown> = {}) => ({ type: "__wm:hb", rss: 100, heapUsed: 50, eventLoopLagMs: 1, ...extra });

describe("HealthMonitor — primary side", () => {
  it("registers valid reports and forwards them", () => {
    const { monitor, events } = makeMonitor();
    monitor.onWorkerMessage(1, 1000, HB());
    expect(events).toContainEqual({ kind: "report", payload: expect.objectContaining({ workerId: 1, pid: 1000, rss: 100 }) });
  });

  it("ignores non-health and malformed messages", () => {
    const { monitor, events } = makeMonitor();
    monitor.onWorkerMessage(1, 1000, { type: "__wm:shutdown" });
    monitor.onWorkerMessage(1, 1000, { type: "__wm:hb", rss: "big" });
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
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("sends a report on each beat with computed lag", () => {
    vi.setSystemTime(1_000);
    const send = vi.spyOn(process, "send").mockImplementation(() => true);
    const { monitor } = makeMonitor({ health: { heartbeatMs: 500 } });
    monitor.startWorkerReporting();
    vi.advanceTimersByTime(1_100); // 2 beats, second 100ms late
    expect(send).toHaveBeenCalledTimes(2);
    const second = send.mock.calls[1][0] as Record<string, unknown>;
    expect(second.type).toBe("__wm:hb");
    expect(second.eventLoopLagMs).toBe(100);
    monitor.stopWorkerReporting();
    vi.advanceTimersByTime(2_000);
    expect(send).toHaveBeenCalledTimes(2);
    send.mockRestore();
  });
});
```

- [ ] **Step 2: Run → fail** (`vitest run test/health-monitor.test.ts` — module missing).

- [ ] **Step 3: Implement `src/health-monitor.ts`**

```ts
import type { Logger, ResolvedConfig, WorkerHealthReport } from "./types";
import { isTypedMessage } from "./types";

export type RecycleTrigger = "rss" | "wedged";

export interface HealthMonitorDeps {
  isShuttingDown: () => boolean;
  recycleWorker: (workerId: number, reason: RecycleTrigger) => void;
  onHealthReport: (report: WorkerHealthReport) => void;
  onWedged: (info: { workerId: number; pid: number; silentMs: number }) => void;
}

/**
 * Worker health heartbeat and primary-side policies (RSS recycle, wedged kill).
 * Worker side: periodic report over IPC (RSS, heap, event-loop beat drift).
 * Primary side: per-worker registry feeding the opt-in policies.
 * Pure plumbing: every observable outcome is delegated to the Orchestrator via deps.
 */
export class HealthMonitor {
  private readonly cfg: ResolvedConfig;
  private readonly log: Logger | null;
  private readonly deps: HealthMonitorDeps;
  private readonly registry = new Map<number, { pid: number; lastReport: number; report: WorkerHealthReport }>();
  private readonly rssRecycled = new Set<number>();
  private reportTimer?: NodeJS.Timeout;
  private wedgedTimer?: NodeJS.Timeout;
  private lastBeat = 0;

  constructor(cfg: ResolvedConfig, log: Logger | null, deps: HealthMonitorDeps) {
    this.cfg = cfg;
    this.log = log;
    this.deps = deps;
  }

  // ---- Worker side ---------------------------------------------------------

  /** Start periodic health reports over IPC. No-op when heartbeat is disabled. */
  startWorkerReporting(): void {
    const interval = this.cfg.health.heartbeatMs;
    if (interval <= 0) return;
    if (typeof process.send !== "function") return; // not a cluster worker
    this.lastBeat = Date.now();
    const type = `${this.cfg.shutdown.messagePrefix}:hb`;
    this.reportTimer = setInterval(() => {
      const now = Date.now();
      // Beat drift = how late this beat fired = event-loop stall indicator.
      const lag = Math.max(0, Math.round(now - this.lastBeat - interval));
      this.lastBeat = now;
      const { rss, heapUsed } = process.memoryUsage();
      try {
        process.send?.({ type, rss, heapUsed, eventLoopLagMs: lag });
      } catch {
        /* IPC channel closed (drain) — reporting is best-effort */
      }
    }, interval);
    this.reportTimer.unref();
  }

  stopWorkerReporting(): void {
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = undefined;
  }

  // ---- Primary side --------------------------------------------------------

  /** Route an IPC message; only health reports are consumed. */
  onWorkerMessage(workerId: number, pid: number, msg: unknown): void {
    if (!isTypedMessage(msg, `${this.cfg.shutdown.messagePrefix}:hb`)) return;
    const m = msg as Record<string, unknown>;
    const { rss, heapUsed, eventLoopLagMs } = m as Record<string, number>;
    if (typeof rss !== "number" || typeof heapUsed !== "number" || typeof eventLoopLagMs !== "number") return;
    const report: WorkerHealthReport = { workerId, pid, rss, heapUsed, eventLoopLagMs };
    this.registry.set(workerId, { pid, lastReport: Date.now(), report });
    this.deps.onHealthReport(report);
    this.checkRssLimit(workerId, report);
  }

  private checkRssLimit(workerId: number, report: WorkerHealthReport): void {
    const limitMb = this.cfg.workers.maxRssMb;
    if (limitMb <= 0 || this.deps.isShuttingDown()) return;
    if (this.rssRecycled.has(workerId)) return; // one-shot per worker instance
    if (report.rss <= limitMb * 1024 * 1024) return;
    this.rssRecycled.add(workerId);
    this.log?.warn("Worker exceeded RSS limit, recycling", {
      workerId,
      rssMb: Math.round(report.rss / 1048576),
      maxRssMb: limitMb,
    });
    this.deps.recycleWorker(workerId, "rss");
  }

  /** Primary-side watch for wedged workers. Only workers that reported at least
   * once are eligible (a worker that never reported may simply be slow to boot). */
  startWedgedWatch(): void {
    const timeoutMs = this.cfg.health.wedgedTimeoutMs;
    if (timeoutMs <= 0) return;
    this.wedgedTimer = setInterval(() => {
      if (this.deps.isShuttingDown()) return;
      const now = Date.now();
      for (const [workerId, entry] of this.registry) {
        const silentMs = now - entry.lastReport;
        if (silentMs <= timeoutMs) continue;
        this.registry.delete(workerId); // fire once — the recycle owns the rest
        this.log?.warn("Worker heartbeat silent, draining it as wedged", { workerId, silentMs });
        this.deps.onWedged({ workerId, pid: entry.pid, silentMs });
        this.deps.recycleWorker(workerId, "wedged");
      }
    }, this.cfg.health.heartbeatMs).unref();
  }

  onWorkerExit(workerId: number): void {
    this.registry.delete(workerId);
    this.rssRecycled.delete(workerId);
  }

  stop(): void {
    this.stopWorkerReporting();
    if (this.wedgedTimer) clearInterval(this.wedgedTimer);
    this.wedgedTimer = undefined;
    this.registry.clear();
    this.rssRecycled.clear();
  }
}
```

- [ ] **Step 4: Wire the message tap** — in `src/worker-manager.ts`:

```ts
// setupEventHandlers gains a third parameter (update the Orchestrator call site accordingly):
    onMessage: (worker: Worker, msg: unknown) => void,

// New private field:  private onWorkerMessageCallback?: (worker: Worker, msg: unknown) => void;
// Store it in setupEventHandlers: this.onWorkerMessageCallback = onMessage;
// In forkWorker(), next to the existing worker.on("error", ...) listener:
    worker.on("message", (msg) => this.onWorkerMessageCallback?.(worker, msg));
```

- [ ] **Step 5: Wire the Orchestrator** — in `src/orchestrator.ts`:

```ts
// Field:      private healthMonitor!: HealthMonitor;
// Import:     import { HealthMonitor } from "./health-monitor";
// In the constructor, after the DrainCoordinator construction:
    this.healthMonitor = new HealthMonitor(
      this.cfg,
      withLoggerPrefix(this.baseLog, "clusterkit:health-monitor"),
      {
        isShuttingDown: () => this.shutdownCoordinator.isShutdownInProgress(),
        recycleWorker: (workerId, reason) => this.triggerWorkerRecycle(workerId, reason),
        onHealthReport: (report) => this.safeEmit("worker:health", report),
        onWedged: (info) => this.safeEmit("worker:wedged", info),
      },
    );

// In setupEventHandlers call (constructor), add the third callback:
      (worker, msg) => this.healthMonitor.onWorkerMessage(worker.id, worker.process.pid ?? 0, msg),

// Private method (placed near handleWorkerRecycle; body lands in Task 4 —
// for Task 2 a neutral stub keeps the suite green):
  private triggerWorkerRecycle(_workerId: number, _reason: "rss" | "wedged"): void {}

// In startWorker(), before `await start?.();`:
    this.healthMonitor.startWorkerReporting();
// and as the first statement inside the handleShutdown closure:
    this.healthMonitor.stopWorkerReporting();

// In shutdownPrimary(), next to `this.workerManager.stopRecycling();`:
    this.healthMonitor.stop();
```

- [ ] **Step 6: Coverage floor** — in `packages/worker-manager/vitest.config.ts`, add to the coverage thresholds map: `"src/health-monitor.ts": { lines: 95, branches: 85 }` (mirroring the coordinator entries).

- [ ] **Step 7: Run tests → green, commit**

Run: `corepack pnpm --filter @goopil/clusterkit test` (full suite) — PASS.

```bash
git add -A && git commit -m "feat(core): HealthMonitor with worker heartbeat and IPC routing"
```

---

### Task 3: Fleet health surface — `getFleetHealth()` + degraded/recovered events

**Files:**
- Modify: `packages/worker-manager/src/orchestrator.ts`
- Test: `packages/worker-manager/test/orchestrator.test.ts` (append)

**Interfaces:**
- Consumes: `resolveWorkerCount()`, `metrics.activeWorkers`, `crashTracker`, `restartCoordinator.getQuarantinedCount()` (added in Task 6 — for now the call reads `0`; Task 6 will provide the real counter. To keep Task 3 self-contained, call it through an optional chain: `this.restartCoordinator.getQuarantinedCount?.() ?? 0` and add the method in Task 6).
- Produces: public `getFleetHealth(): FleetHealth`; private `recomputeFleetHealth(): void` + state fields.

- [ ] **Step 1: Write failing tests** (orchestrator.test.ts — use the existing mock-worker harness; emit fake worker exits/online events or drive `metrics.activeWorkers` through the existing helpers of that file):

```ts
describe("fleet health", () => {
  it("reports target/active/breaker and stays healthy at capacity", async () => {
    const o = await bootOrchestrator({ workers: 2 }); // existing harness helper in this file
    expect(o.getFleetHealth()).toMatchObject({ target: 2, active: 2, quarantined: 0, breaker: { tripped: false } });
    await o.shutdownPrimary("SIGTERM");
  });

  it("emits fleet:degraded after the hysteresis and fleet:recovered with duration", async () => {
    vi.useFakeTimers();
    const degraded: unknown[] = [];
    const recovered: unknown[] = [];
    const o = await bootOrchestrator({ workers: 2, health: { degradedAfterMs: 1_000 } });
    o.on("fleet:degraded", (d) => degraded.push(d));
    o.on("fleet:recovered", (d) => recovered.push(d));
    // drop one worker without replacement (simulate crash with restart suppressed)
    vi.mocked(o["restartCoordinator" as never]) // if the harness drives real workers, kill one process instead
    // ... drive via the file's existing crash helper so metrics.activeWorkers drops to 1
    await vi.advanceTimersByTimeAsync(1_001);
    expect(degraded).toHaveLength(1);
    // restore capacity through the existing online helper
    await vi.advanceTimersByTimeAsync(10);
    expect(recovered[0]).toMatchObject({ degradedDurationMs: expect.any(Number) });
    await o.shutdownPrimary("SIGTERM");
    vi.useRealTimers();
  });

  it("does not emit degraded during shutdown", async () => {
    // existing shutdown helper; start shutdown, assert no fleet:degraded even below target
  });
});
```

(Adapt the exact helper names to the file's existing boot/crash helpers — read the top of `test/orchestrator.test.ts` first and reuse them.)

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement in `orchestrator.ts`**:

```ts
// New fields:
  private fleetDegraded = false;
  private degradedSince = 0;
  private degradedTimer?: NodeJS.Timeout;

// Public API (next to getHealth):
  /** Fleet-level health snapshot: capacity vs target, quarantined slots, breaker state. */
  getFleetHealth(): FleetHealth {
    const target = this.resolveWorkerCount();
    return {
      target,
      active: this.metrics.activeWorkers,
      quarantined: this.restartCoordinator.getQuarantinedCount?.() ?? 0,
      breaker: { count: this.crashTracker.count, tripped: this.crashTracker.isTripped() },
    };
  }

// Private (near handleWorkerOnline):
  private recomputeFleetHealth(): void {
    if (this.shutdownCoordinator.isShutdownInProgress()) return;
    const target = this.resolveWorkerCount();
    if (this.metrics.activeWorkers >= target) {
      if (this.degradedTimer) {
        clearTimeout(this.degradedTimer);
        this.degradedTimer = undefined;
      }
      if (this.fleetDegraded) {
        this.fleetDegraded = false;
        this.safeEmit("fleet:recovered", {
          target,
          active: this.metrics.activeWorkers,
          degradedDurationMs: Date.now() - this.degradedSince,
        });
      }
      return;
    }
    if (this.fleetDegraded || this.degradedTimer) return;
    this.degradedSince = Date.now();
    this.degradedTimer = setTimeout(() => {
      this.degradedTimer = undefined;
      if (this.shutdownCoordinator.isShutdownInProgress()) return;
      this.fleetDegraded = true;
      this.safeEmit("fleet:degraded", { target: this.resolveWorkerCount(), active: this.metrics.activeWorkers });
    }, this.cfg.health.degradedAfterMs).unref();
  }

// Call sites: end of handleWorkerOnline() and end of handleWorkerExit() (both paths, before early returns where capacity changed — safest: call at the very end of each non-shutdown-return path AND after the shutdown-return guard so shutdown skips it).
// shutdownPrimary(): clear the hysteresis state next to healthMonitor.stop():
    if (this.degradedTimer) clearTimeout(this.degradedTimer);
    this.degradedTimer = undefined;
    this.fleetDegraded = false;
```

- [ ] **Step 4: Run → green, commit**

```bash
git add -A && git commit -m "feat(core): fleet health surface with degraded/recovered events"
```

---

### Task 4: RSS recycling policy

**Files:**
- Modify: `packages/worker-manager/src/worker-manager.ts`
- Modify: `packages/worker-manager/src/orchestrator.ts`
- Test: `packages/worker-manager/test/health-monitor.test.ts` (policy pins), `packages/worker-manager/test/orchestrator.test.ts` (wiring)

**Interfaces:**
- Consumes: `HealthMonitor.checkRssLimit` deps (Task 2), existing `handleWorkerRecycle`.
- Produces: `WorkerManager.recycleWorkerNow(workerId: number, reason: "rss" | "wedged", isShuttingDown: () => boolean, onRecycle: (oldWorker: Worker, newWorker: Worker) => void): boolean`; `WorkerManager.isMarkedForRecycling(workerId: number): boolean`; `worker:recycle` payload now carries `reason`.

- [ ] **Step 1: Monitor-level policy pins** (append to `test/health-monitor.test.ts`; these pin the Task 2 module behavior):

```ts
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
    const shutting = makeMonitor({ workers: { maxRssMb: 100 } });
    (shutting.monitor as unknown as { deps: { isShuttingDown: () => void } }).deps.isShuttingDown = vi.fn(() => true);
    shutting.monitor.onWorkerMessage(1, 1000, HB({ rss: 200 * 1024 * 1024 }));
    const off = makeMonitor();
    off.monitor.onWorkerMessage(1, 1000, HB({ rss: 999 * 1024 * 1024 }));
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Orchestrator wiring tests** (append to `test/orchestrator.test.ts`, reusing the file's existing boot/crash helpers; the mock cluster harness in that file already yields controllable workers):

```ts
describe("rss recycling", () => {
  it("drains a worker over maxRssMb and emits worker:recycle with reason rss", async () => {
    const events: unknown[] = [];
    const o = await bootOrchestrator({ workers: 2, workers_maxRssMb: 100 }); // adapt to the harness option shape
    o.on("worker:recycle", (d) => events.push(d));
    const id = /* pick one worker id from the harness */;
    reportHealth(o, id, 200 * 1024 * 1024); // helper: (o as any).healthMonitor.onWorkerMessage(id, pid, { type: "__wm:hb", rss, heapUsed: 0, eventLoopLagMs: 0 })
    await vi.advanceTimersByTimeAsync(0); // let the replacement fork + drain start
    expect(events[0]).toMatchObject({ workerId: id, reason: "rss" });
    expect(o.getMetrics().crashLoopBackoffs).toBe(0); // NOT a crash — breaker untouched
    await o.shutdownPrimary("SIGTERM");
  });
});
```

- [ ] **Step 3: Run → fail** (no recycle happens yet).

- [ ] **Step 4: Implement** — `worker-manager.ts`:

```ts
  /** True when this worker id is already marked for recycling. */
  isMarkedForRecycling(workerId: number): boolean {
    return this.recyclingWorkerIds.has(workerId);
  }

  /**
   * Immediately recycle one worker (RSS limit or wedged detection): mark it,
   * fork the replacement now, hand both to onRecycle (bounded drain of the old
   * one). Mirrors the aged-worker fork-failure handling: on fork error the
   * worker is unmarked and left running for the next sweep.
   */
  recycleWorkerNow(
    workerId: number,
    reason: "rss" | "wedged",
    isShuttingDown: () => boolean,
    onRecycle: (oldWorker: Worker, newWorker: Worker) => void,
  ): boolean {
    if (isShuttingDown()) return false;
    if (this.recyclingWorkerIds.has(workerId)) return false;
    const worker = this.getActiveWorkers().find((w) => w.id === workerId);
    if (!worker) return false;
    this.recyclingWorkerIds.add(workerId);
    this.log?.info("Recycling worker", { workerId, reason });
    let newWorker: Worker;
    try {
      newWorker = this.forkWorker();
    } catch (err) {
      this.recyclingWorkerIds.delete(workerId);
      this.log?.error("Recycle fork failed — worker left running", {
        workerId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    onRecycle(worker, newWorker);
    return true;
  }

// startRecycling(): gate and age filter become signal-aware:
    if (this.cfg.workers.maxAgeMs <= 0 && this.cfg.workers.maxRssMb <= 0) return;
    // inside the sweep filter:
        if (this.cfg.workers.maxAgeMs > 0 && age > this.cfg.workers.maxAgeMs) return true;
        return false;
```

- [ ] **Step 5: Implement** — `orchestrator.ts`:

```ts
// Field:  private readonly recycleReasons = new Map<number, RecycleReason>();

// Replace the Task 2 stub:
  private triggerWorkerRecycle(workerId: number, reason: "rss" | "wedged"): void {
    if (this.workerManager.isMarkedForRecycling(workerId)) return;
    this.recycleReasons.set(workerId, reason);
    const ok = this.workerManager.recycleWorkerNow(
      workerId,
      reason,
      () => this.shutdownCoordinator.isShutdownInProgress(),
      (oldWorker, newWorker) => this.handleWorkerRecycle(oldWorker, newWorker),
    );
    if (!ok) this.recycleReasons.delete(workerId);
  }

// handleWorkerRecycle(): carry the reason through the existing event:
  private handleWorkerRecycle(oldWorker: Worker, newWorker: Worker): void {
    const ageMs = this.workerManager.getWorkerAge(oldWorker.id);
    const reason = this.recycleReasons.get(oldWorker.id) ?? "maxAge";
    this.recycleReasons.delete(oldWorker.id);
    this.safeEmit("worker:recycle", { workerId: oldWorker.id, pid: oldWorker.process.pid ?? 0, ageMs, reason });
    this.drainCoordinator.recycle(oldWorker, newWorker);
  }
```

- [ ] **Step 6: README + changeset** — README `workers.maxRssMb` row + Linux sizing recipe (≈ 70% × (cgroup memory − primary overhead) / workers); changeset `feat: opt-in RSS-based worker recycling (workers.maxRssMb)`.

- [ ] **Step 7: Run suite → green, commit**

```bash
git add -A && git commit -m "feat(core): opt-in RSS-based worker recycling through the bounded drain"
```

---

### Task 5: Wedged-worker policy

**Files:**
- Modify: `packages/worker-manager/src/orchestrator.ts` (single call site)
- Test: `packages/worker-manager/test/health-monitor.test.ts`, `packages/worker-manager/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `HealthMonitor.startWedgedWatch()` (implemented in Task 2), `triggerWorkerRecycle` (Task 4).
- Produces: behavioral only — `worker:wedged` event + recycle with `reason: "wedged"`.

- [ ] **Step 1: Unit pins** (append to `test/health-monitor.test.ts`, fake timers):

```ts
describe("HealthMonitor — wedged watch", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function makeWatching() {
    return makeMonitor({ health: { heartbeatMs: 500, wedgedTimeoutMs: 1_500 } });
  }

  it("drains a worker silent beyond wedgedTimeoutMs (reported at least once)", () => {
    const { monitor, events } = makeWatching();
    monitor.onWorkerMessage(1, 1000, HB());
    monitor.startWedgedWatch();
    vi.advanceTimersByTime(2_000);
    expect(events.some((e) => e.kind === "wedged" && (e.payload as { workerId: number }).workerId === 1)).toBe(true);
    expect(events.some((e) => e.kind === "recycle:wedged")).toBe(true);
  });

  it("never flags a worker that never reported (first-report precondition)", () => {
    const { monitor, events } = makeWatching();
    monitor.startWedgedWatch();
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(0);
  });

  it("keeps a worker that keeps reporting", () => {
    const { monitor, events } = makeWatching();
    monitor.onWorkerMessage(1, 1000, HB());
    monitor.startWedgedWatch();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(500);
      monitor.onWorkerMessage(1, 1000, HB());
    }
    expect(events).toHaveLength(5); // only the reports, no wedged
  });

  it("is inert when wedgedTimeoutMs is 0", () => {
    const { monitor, events } = makeMonitor({ health: { heartbeatMs: 500 } });
    monitor.onWorkerMessage(1, 1000, HB());
    monitor.startWedgedWatch();
    vi.advanceTimersByTime(60_000);
    expect(events).toHaveLength(1); // the report only
  });
});
```

- [ ] **Step 2: Orchestrator wiring** — in `startPrimary()` (grep the existing `startRecycling` call), add next to it:

```ts
    this.healthMonitor.startWedgedWatch();
```

Plus one orchestrator test: wedge a harness worker (stop its reports via the harness), advance fake timers past the timeout, assert `worker:wedged` fired then the worker was recycled with `reason: "wedged"` (adapt helper names to the file).

- [ ] **Step 3: Run suite → green; README (health options table rows + tuning guidance: choose `wedgedTimeoutMs` ≫ worst-case expected event-loop stall) + changeset; commit**

```bash
git add -A && git commit -m "feat(core): wedged-worker detection and bounded drain"
```

---

### Task 6: Boot-loop quarantine

**Files:**
- Modify: `packages/worker-manager/src/restart-coordinator.ts`
- Modify: `packages/worker-manager/src/orchestrator.ts`
- Test: `packages/worker-manager/test/restart-coordinator.test.ts`, `packages/worker-manager/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: existing `onWorkerCrash` signature gains an optional 4th param (back-compatible: `bootFailed = false` keeps every existing test valid).
- Produces: `RestartCoordinatorDeps` gains `hasOnlineWorkers: () => boolean` and `onQuarantined: (info: { consecutiveBootFailures: number }) => void`; new methods `getQuarantinedCount(): number`, `resetQuarantine(): void`.

- [ ] **Step 1: Write failing tests** (append to `test/restart-coordinator.test.ts`; extend the `Harness` deps with `hasOnlineWorkers: vi.fn(() => true)` and `onQuarantined: (info) => quarantined.push(info)`):

```ts
describe("boot-loop quarantine", () => {
  function bootFailingHarness(overrides: { target?: number; quarantine?: number } = {}) {
    const h = makeCoordinator({
      restart: { bootFailQuarantine: overrides.quarantine ?? 3 },
      target: overrides.target ?? 2,
      recycling: 0,
    });
    return h;
  }

  it("quarantines after N consecutive boot failures while other workers serve", () => {
    const h = bootFailingHarness({ quarantine: 3 });
    crash(h, 1); // boot failure #1 — pre-quarantine: normal restart
    expect(h.fork).toHaveBeenCalledTimes(1);
    crash(h, 2); // #2
    crash(h, 3); // #3 → quarantine
    expect(h.fork).toHaveBeenCalledTimes(2); // no third fork
    expect(h.metrics.crashLoopBackoffs).toBe(0); // not counted toward the breaker
  });

  it("keeps legacy behavior (record + backoff) when no worker is online", () => {
    const h = bootFailingHarness({ quarantine: 2 });
    h.metrics.activeWorkers = 0;
    crash(h, 1);
    expect(h.fork).toHaveBeenCalledTimes(1); // queued restart as before
  });

  it("never quarantines when bootFailQuarantine is 0 (default)", () => {
    const h = makeCoordinator({ restart: { bootFailQuarantine: 0 } });
    crash(h, 1);
    crash(h, 2);
    expect(h.fork).toHaveBeenCalledTimes(2);
  });

  it("a successful boot resets the streak", () => {
    const h = bootFailingHarness({ quarantine: 2 });
    crash(h, 1);
    h.coordinator.onWorkerOnline(2); // replacement boots fine
    crash(h, 3);
    expect(h.fork).toHaveBeenCalledTimes(2); // streak was reset — no quarantine
  });

  it("runtime crashes (booted workers) never count toward the streak", () => {
    const h = bootFailingHarness({ quarantine: 1 });
    crash(h, 1); // bootFailed = false → normal crash path
    expect(h.fork).toHaveBeenCalledTimes(1);
  });

  it("resetQuarantine clears the counters", () => {
    const h = bootFailingHarness({ quarantine: 1 });
    crash(h, 1);
    expect(h.coordinator.getQuarantinedCount()).toBe(1);
    h.coordinator.resetQuarantine();
    expect(h.coordinator.getQuarantinedCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement in `restart-coordinator.ts`**:

```ts
// New fields:
  private consecutiveBootFailures = 0;
  private quarantinedSlots = 0;

// onWorkerCrash — new signature and quarantine gate BEFORE the crash record:
  onWorkerCrash(workerId: number, code: number | null, signal: string | null, bootFailed = false): void {
    const quarantine = this.cfg.restart.bootFailQuarantine;
    if (bootFailed && quarantine > 0 && this.deps.hasOnlineWorkers()) {
      this.consecutiveBootFailures++;
      if (this.consecutiveBootFailures >= quarantine) {
        this.quarantinedSlots++;
        this.log?.warn("Boot-loop detected — quarantining slot (no re-fork)", {
          workerId,
          consecutiveBootFailures: this.consecutiveBootFailures,
        });
        this.deps.onQuarantined({ consecutiveBootFailures: this.consecutiveBootFailures });
        // Deliberately no crash record and no restart: one bad slot must not
        // poison the fleet breaker or burn forks. Remedy: restartWorkers().
        return;
      }
      // Pre-quarantine boot failure: a real crash — fall through to the
      // record + restart path below.
    }
    // ... existing body unchanged (record, breaker reactions, queue restart)
  }

// onWorkerOnline(): add as first statement — any successful boot resets the streak:
    this.consecutiveBootFailures = 0;

// New public methods:
  getQuarantinedCount(): number {
    return this.quarantinedSlots;
  }

  resetQuarantine(): void {
    this.quarantinedSlots = 0;
    this.consecutiveBootFailures = 0;
  }
```

- [ ] **Step 4: Orchestrator wiring**:

```ts
// Field:  private readonly onlineWorkerIds = new Set<number>();
// handleWorkerOnline(): first statement —
    this.onlineWorkerIds.add(worker.id);
// handleWorkerExit(): inside the crash branch (after the graceful-exit returns), before onWorkerCrash:
    const bootFailed = !this.onlineWorkerIds.has(worker.id);
    this.onlineWorkerIds.delete(worker.id);
    this.healthMonitor.onWorkerExit(worker.id);
    this.recomputeFleetHealth();
    this.safeEmit("worker:crash", { workerId: worker.id, pid: worker.process.pid ?? 0, code, signal });
    this.restartCoordinator.onWorkerCrash(worker.id, code, signal, bootFailed);
// (graceful exits also clear the id: add `this.onlineWorkerIds.delete(worker.id);` in the
//  graceful-exit branch too.)

// RestartCoordinator deps (constructor) gain:
        hasOnlineWorkers: () => this.metrics.activeWorkers > 0,
        onQuarantined: (info) => this.safeEmit("worker:quarantined", info),

// restartWorkers(): first statement —
    this.restartCoordinator.resetQuarantine();
```

Also add the online/exit-side calls from Task 3 if not already present: `healthMonitor.onWorkerExit(worker.id)` must run on **every** exit path (graceful included).

- [ ] **Step 5: README + changeset; run suite → green; commit**

```bash
git add -A && git commit -m "feat(core): boot-loop quarantine with online-guard"
```

---

### Task 7: Prometheus plugin — health metrics

**Files:**
- Modify: `packages/plugin-prometheus/src/index.ts`
- Test: `packages/plugin-prometheus/test/prometheus.test.ts`

**Interfaces:**
- Consumes: `worker:health`, `worker:recycle`, `worker:wedged`, `worker:quarantined`, `fleet:degraded`, `fleet:recovered` (Orchestrator events, Tasks 2-6) and `orchestrator.getFleetHealth()`.
- Produces: metrics listed in spec §9.1. Use per-test isolated registries and `defaultMetrics: false` (existing repo rule).

- [ ] **Step 1: Write failing tests** (mirror the file's existing isolated-registry test setup):

```ts
it("exposes worker health gauges from worker:health events", async () => {
  const { plugin, registry } = makePlugin(); // existing helper
  const o = new Orchestrator({ workers: 1, logger: null });
  o.use(plugin);
  await o.run(async () => {});
  o.emit("worker:health", { workerId: 7, pid: 7007, rss: 1e8, heapUsed: 5e7, eventLoopLagMs: 3 });
  const text = await plugin.getMetrics();
  expect(text).toContain('clusterkit_worker_rss_bytes{workerId="7"} 1e+08');
  expect(text).toContain('clusterkit_worker_eventloop_lag_ms{workerId="7"} 0');
});

it("counts recycles by reason and wedged kills", async () => {
  // emit worker:recycle { reason: "rss" } ×2, { reason: "maxAge" } ×1, worker:wedged ×1
  // assert clusterkit_worker_recycles_total{reason="rss"} 2, {reason="maxAge"} 1
  // assert clusterkit_worker_wedged_kills_total 1
});

it("exposes fleet gauges via live collection", async () => {
  // with 2 workers up: clusterkit_fleet_active_workers 2, clusterkit_fleet_target_workers 2
  // after one crash without replacement: active 1 → assert again
});

it("records recovery duration on fleet:recovered", async () => {
  // emit fleet:recovered { target: 2, active: 2, degradedDurationMs: 4321 }
  // assert clusterkit_recovery_duration_seconds ≈ 4.321
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** (in `plugin-prometheus/src/index.ts`, registering alongside the existing orchestration metrics; worker-scoped gauges keep a `Map<workerId, lastReport>` for heartbeat-age computation):

```ts
const workerIdLabel = ["workerId"];

const workerRss = new client.Gauge({
  name: "clusterkit_worker_rss_bytes",
  help: "Resident set size per worker (from health heartbeat)",
  labelNames: workerIdLabel,
  registers: [registry],
});
const workerHeap = new client.Gauge({ name: "clusterkit_worker_heap_used_bytes", help: "...", labelNames: workerIdLabel, registers: [registry] });
const workerLag = new client.Gauge({ name: "clusterkit_worker_eventloop_lag_ms", help: "...", labelNames: workerIdLabel, registers: [registry] });
const heartbeatAge = new client.Gauge({
  name: "clusterkit_worker_heartbeat_age_seconds",
  help: "Seconds since the worker's last health report (large = wedged risk)",
  labelNames: workerIdLabel,
  collect() {
    const now = Date.now();
    for (const [id, ts] of lastReports) this.set({ workerId: String(id) }, (now - ts) / 1000);
  },
  registers: [registry],
});
const fleetActive = new client.Gauge({ name: "clusterkit_fleet_active_workers", help: "...", collect() { this.set(orchestrator.getFleetHealth().active); }, registers: [registry] });
const fleetTarget = new client.Gauge({ name: "clusterkit_fleet_target_workers", help: "...", collect() { this.set(orchestrator.getFleetHealth().target); }, registers: [registry] });
const fleetQuarantined = new client.Gauge({ name: "clusterkit_fleet_quarantined_slots", help: "...", collect() { this.set(orchestrator.getFleetHealth().quarantined); }, registers: [registry] });
const recycles = new client.Counter({ name: "clusterkit_worker_recycles_total", help: "...", labelNames: ["reason"], registers: [registry] });
const wedgedKills = new client.Counter({ name: "clusterkit_worker_wedged_kills_total", help: "...", registers: [registry] });
const recoveryDuration = new client.Gauge({ name: "clusterkit_recovery_duration_seconds", help: "...", registers: [registry] });

// Event wiring (same pattern as the existing orchestration metrics):
  orchestrator.on("worker:health", ({ workerId, rss, heapUsed, eventLoopLagMs }) => {
    lastReports.set(workerId, Date.now());
    workerRss.set({ workerId: String(workerId) }, rss);
    workerHeap.set({ workerId: String(workerId) }, heapUsed);
    workerLag.set({ workerId: String(workerId) }, eventLoopLagMs);
  });
  orchestrator.on("worker:exit", ({ workerId }) => {
    lastReports.delete(workerId);
    workerRss.remove({ workerId: String(workerId) });
    workerHeap.remove({ workerId: String(workerId) });
    workerLag.remove({ workerId: String(workerId) });
  });
  orchestrator.on("worker:recycle", ({ reason }) => recycles.inc({ reason }));
  orchestrator.on("worker:wedged", () => wedgedKills.inc());
  orchestrator.on("fleet:recovered", ({ degradedDurationMs }) => recoveryDuration.set(degradedDurationMs / 1000));

// uninstall(): remove all listeners (same list) + clear lastReports.
```

- [ ] **Step 4: Run plugin suite → green; changeset; commit**

```bash
git add -A && git commit -m "feat(plugin-prometheus): worker health, fleet and recovery metrics"
```

---

### Task 8: NODE_COMPILE_CACHE option (plugin-container-sizing)

**Files:**
- Modify: `packages/plugin-container-sizing/src/index.ts` (and `src/types.ts` if the plugin splits option types)
- Test: `packages/plugin-container-sizing/test/plugin.test.ts`
- Docs: `packages/plugin-container-sizing/README.md`

**Interfaces:**
- Produces: plugin option `compileCache?: boolean | string` (default `false`). `true` → `NODE_COMPILE_CACHE = join(tmpdir(), "clusterkit-compile-cache")`; string → used verbatim. Injected into worker env **directly** (env-only setting — never through NODE_OPTIONS).

- [ ] **Step 1: Failing tests** (mirror the file's existing plugin test setup):

```ts
it("injects a default compile cache dir when enabled", () => {
  installPlugin({ compileCache: true });
  expect(patchEnvCall.NODE_OPTIONS).not.toContain("NODE_COMPILE_CACHE");
  expect(patchEnvCall.NODE_COMPILE_CACHE).toBe(join(tmpdir(), "clusterkit-compile-cache"));
});

it("injects a custom compile cache dir", () => {
  installPlugin({ compileCache: "/var/cache/ckc" });
  expect(patchEnvCall.NODE_COMPILE_CACHE).toBe("/var/cache/ckc");
});

it("does not touch worker env when disabled (default)", () => {
  installPlugin({});
  expect(patchEnvCall.NODE_COMPILE_CACHE).toBeUndefined();
});
```

- [ ] **Step 2: Run → fail. Implement** (at the same site where the plugin merges `NODE_OPTIONS` into `patchWorkerEnv`):

```ts
  if (options.compileCache) {
    env.NODE_COMPILE_CACHE =
      typeof options.compileCache === "string" ? options.compileCache : join(tmpdir(), "clusterkit-compile-cache");
  }
```

- [ ] **Step 3: README (option row + tmpfs/content-hash notes) + changeset; run suite → green; commit**

```bash
git add -A && git commit -m "feat(plugin-container-sizing): NODE_COMPILE_CACHE injection option"
```

---

### Task 9: Recovery benchmark (baseline-first)

**Files:**
- Create: `benchmarks/lib/recovery-runner.mjs`
- Modify: `benchmarks/lib/cli.mjs` (`--scenario recovery`, default off), `benchmarks/runner.mjs` (branch in `main()`)
- Modify: `benchmarks/README.md` (scenario docs)
- Results: `benchmarks/results/latest.json`, `benchmarks/results/REPORT.generated.md`, `BENCHMARKS.md` prose

**Interfaces:**
- Produces: `runRecoveryScenario({ targetId, port, expectedWorkers })` → `{ restoreDurationMs, requestsDuringRecovery, bootTimesMs: number[], pidsBefore, pidsKilled }`.

- [ ] **Step 1: Implement `benchmarks/lib/recovery-runner.mjs`** (Linux-only; `/proc` pid discovery, no new deps):

```js
import { readdirSync, readFileSync } from "node:fs";

/** Direct children of a pid, from /proc (Linux only). */
export function childPids(parentPid) {
  const out = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (ppid === parentPid) out.push(Number(entry));
    } catch { /* process vanished mid-scan */ }
  }
  return out;
}

export async function runRecoveryScenario({ targetChild, port, expectedWorkers, measureMs = 10_000 }) {
  const before = childPids(targetChild.pid);
  const victims = before.slice(0, Math.ceil(before.length / 2));
  const pidsSeen = new Set();
  let requests = 0;
  let restoreStart = null;
  let restoreEnd = null;
  const bootTimes = [];
  const poll = async () => {
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/hello`);
        const body = await res.json();
        requests++;
        if (victims.includes(body.pid)) continue;      // a surviving worker answered
        if (!pidsSeen.has(body.pid)) {
          pidsSeen.add(body.pid);
          if (restoreStart === null) restoreStart = Date.now();
          bootTimes.push(Date.now() - restoreStart);
          if (pidsSeen.size >= expectedWorkers) { restoreEnd = Date.now(); return; }
        }
      } catch { /* connection refused — capacity down, keep polling */ }
      await new Promise((r) => setTimeout(r, 100));
      if (restoreEnd) return;
    }
  };
  const t0 = Date.now();
  for (const pid of victims) process.kill(pid, "SIGKILL");
  await poll();
  return {
    restoreDurationMs: Date.now() - t0,
    requestsDuringRecovery: requests,
    bootTimesMs: bootTimes,
    pidsBefore: before,
    pidsKilled: victims,
  };
}
```

- [ ] **Step 2: CLI + runner wiring** — `--scenario recovery` flag; in `runner.mjs` `main()`, a branch before the workload loop: boot the target (`bootTarget`), 5 s warmup, run `runRecoveryScenario`, teardown, collect results for all `--target`s given (default: `clusterkit-3`). Reuse `resolveConfig`/repetitions (median of 3 in reference mode).

- [ ] **Step 3: Baseline protocol (MEASURE BEFORE ANY FEATURE SHIPS)**

1. `corepack pnpm --filter benchmarks exec node runner.mjs --scenario recovery --quick` locally (smoke).
2. Reference run in Docker (`corepack pnpm bench:docker` path or the compose bench service) on clean `main`.
3. Commit `benchmarks/results/latest.json` + `REPORT.generated.md` + a `BENCHMARKS.md` "Recovery baseline" paragraph.
4. After each feature task (4-6), re-run and append the delta row to `BENCHMARKS.md`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(benchmarks): recovery scenario with baseline results"
```

---

### Task 10: E2E chaos suite (Linux) + docs/changesets sweep

**Files:**
- Create: `packages/worker-manager/test/e2e/chaos.e2e.mjs`, `packages/worker-manager/test/e2e/health-fixture.mjs`
- Modify: `docker/docker-compose.yml` (or the repo's compose file — grep `test:` service)
- Modify: `packages/worker-manager/README.md`, `AGENTS.md`, `.changeset/`

**Interfaces:**
- Consumes: built workspace packages (`@goopil/clusterkit`, `@goopil/clusterkit-prometheus`).
- Produces: `node packages/worker-manager/test/e2e/chaos.e2e.mjs` exits 0 when all chaos scenarios pass (Linux + `CKX_E2E=1` only).

- [ ] **Step 1: Fixture app** (`health-fixture.mjs`) — plain `node:http`, zero app deps:

```js
import { Orchestrator } from "@goopil/clusterkit";
import http from "node:http";
import { createConsoleLogger } from "@goopil/clusterkit";

const mode = process.env.CKX_FIXTURE_MODE ?? "normal"; // normal | crash-at-boot | wedge | alloc
const log = createConsoleLogger(); // JSON lines on stdout: events land here for the runner to parse

if (process.env.CKX_IS_WORKER === "1") {
  // Worker behaviors driven by the primary through CKX_WORKER_MODE env
  if (process.env.CKX_WORKER_MODE === "crash-at-boot") process.exit(1);
  const server = http.createServer((req, res) => res.end(JSON.stringify({ pid: process.pid })));
  if (process.env.CKX_WORKER_MODE === "wedge") setTimeout(() => { for (;;) {} /* block loop forever */ }, 2_000);
  if (process.env.CKX_WORKER_MODE === "alloc") setInterval(() => { globalThis.buf = Buffer.alloc(64 * 1024 * 1024); }, 500).unref();
  server.listen(Number(process.env.PORT), "127.0.0.1");
} else {
  const orchestrator = new Orchestrator({
    logger: log,
    workers: { count: 4, maxRssMb: Number(process.env.CKX_MAX_RSS_MB ?? 0) },
    health: { heartbeatMs: 500, wedgedTimeoutMs: Number(process.env.CKX_WEDGE_TIMEOUT ?? 0), degradedAfterMs: 1_000 },
    restart: { bootFailQuarantine: Number(process.env.CKX_QUARANTINE ?? 0) },
  });
  // CKX_QUARANTINE mode: every other fork crashes at boot (deterministic fraction)
  if (process.env.CKX_QUARANTINE) orchestrator.patchWorkerEnv({ CKX_WORKER_MODE: process.pid % 2 === 0 ? "crash-at-boot" : "normal" });
  await orchestrator.run(() => {});
}
```

(Adapt: the worker-vs-primary branch uses `cluster.isWorker` inside the fixture — the Orchestrator re-forks the same entry script; env selects behavior. The primary sets `CKX_WORKER_MODE` per scenario **before** forking; the "every other fork" trick for quarantine uses a counter via a sidecar file or alternating env per restart — prefer a module-level counter file under `/tmp` keyed by pod.)

- [ ] **Step 2: Chaos runner** (`chaos.e2e.mjs`) — spawns the fixture (`child_process.fork`, `CKX_E2E=1`), waits for port, then:

1. **kill chaos**: enumerate fixture children via `/proc` (reuse the Task 9 helper logic), SIGKILL half → assert: all workers replaced (distinct new pids) within 15 s; primary alive; stdout contains `fleet:degraded` then `fleet:recovered`.
2. **wedge chaos**: fixture mode `wedge` with `wedgedTimeoutMs: 2000` → assert `worker:wedged` line + replacement online + total recovery < 15 s.
3. **boot-loop chaos**: fixture mode with `CKX_QUARANTINE=2` → assert exactly 2 consecutive crash-at-boot forks then a `worker:quarantined` line, and the healthy workers keep serving (HTTP 200 during the whole window).
4. **metrics**: with `@goopil/clusterkit-prometheus` mounted in the fixture, assert `/metrics` (or `plugin.getMetrics()`) contains `clusterkit_worker_rss_bytes`, `clusterkit_fleet_active_workers`, `clusterkit_recovery_duration_seconds`.

Exit non-zero on any failed assertion; print a summary table. Guard: `if (process.platform !== "linux" || !process.env.CKX_E2E) { console.log("skipped (Linux e2e)"); process.exit(0); }`

- [ ] **Step 3: Compose wiring** — add service `e2e-health` mirroring the existing `test` service with `command: node packages/worker-manager/test/e2e/chaos.e2e.mjs` and `environment: CKX_E2E: "1"`. Local check first: `CKX_E2E=1 node packages/worker-manager/test/e2e/chaos.e2e.mjs` (macOS allowed for dev; CI asserts on Linux).

- [ ] **Step 4: Docs sweep** — core README: `health` config table, all new events with payloads, `getFleetHealth()`, `maxRssMb` sizing recipe, quarantine semantics + remedy; AGENTS.md: `health-monitor.ts` entry under core modules + platform policy note; changesets for core + prometheus + container-sizing if not yet added.

- [ ] **Step 5: Full CI gate locally, then PR**

```bash
source ~/.nvm/nvm.sh && nvm use
corepack pnpm build && corepack pnpm test && corepack pnpm lint || true   # lint: pre-existing local-only failures documented in session
corepack pnpm --filter benchmarks smoke
git add -A && git commit -m "test(e2e): Linux chaos suite for worker health + docs sweep"
git push -u origin feat/worker-health-recovery
gh pr create --title "feat(core): worker health & recovery subsystem" --body "See docs/superpowers/specs/2026-09-04-worker-health-recovery-design.md"
```

---

## Self-review notes (for the executor)

- Spec coverage: config/types (T1), heartbeat (T2), fleet health (T3), RSS (T4), wedged (T5), quarantine (T6), metrics (T7), compile cache (T8), recovery bench (T9), e2e + docs (T10). §9.2 gates: floors in T2, exact assertions in T4/T6, e2e thresholds in T10.
- Type consistency: `RecycleTrigger` (monitor deps) vs `RecycleReason` (event payload) — the orchestrator bridges them; `worker:recycle.reason` is always populated (default "maxAge").
- Adaptation duty: test helper names (`bootOrchestrator`, `crash`, `makePlugin`) MUST be read from the existing test files at implementation time and reused — never re-invent a parallel harness.
- The `worker:recycle` payload extension is additive: existing consumers (prometheus plugin counts restarts) keep working.
- Non-goals guard: no restore-speed policy changes in this plan (Task 9 only measures); no reuseport/BPF work.
