# OTLP Meter Health/Fleet/Recovery Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the same metric set as `plugin-prometheus` from `plugin-otlp-meter` (per-worker health gauges, recycle/wedged counters, live fleet gauges, recovery duration) using OpenTelemetry idioms.

**Architecture:** Primary-side only. Extend the existing event-binding mechanism with a typed `bind()` (mirroring `plugin-prometheus`), back per-worker observable gauges with a `Map<workerId, sample>` updated from `worker:health`/`worker:exit` events, read fleet state live via `orchestrator.getFleetHealth()` in observable callbacks, and record event-payload values into a sync gauge (`recovery.duration_seconds`) and counters. Observable gauges read live state at export time, so no uninstall registry cleanup is needed.

**Tech Stack:** TypeScript, `@opentelemetry/api` (^1.9.0 — `createGauge` available), `@opentelemetry/sdk-metrics` (^2.10.0), vitest. Spec: `docs/superpowers/specs/2026-09-05-otlp-health-parity-design.md`.

## Global Constraints

- Worktree: `/Users/zacharyvolpi/dev/perso/nodejs-multi-worker/.worktrees/feat-otlp-health-parity`, branch `feat/otlp-health-parity`.
- Before ANY command: `source ~/.nvm/nvm.sh && nvm use` (Node 22 via `.nvmrc`). Package manager: `corepack pnpm`, never bare `pnpm`.
- No new dependencies (runtime or dev). Peer deps already cover everything.
- All metric names: `prefix` (default `clusterkit.`) + dot-separated suffix (e.g. `worker.rss_bytes`). No renames of existing metrics.
- All code, comments, tests, docs in English. Do not add code comments unless essential (match existing file style — it uses targeted explanatory comments).
- Coverage floors in `packages/plugin-otlp-meter/vitest.config.ts`: `"src/index.ts": { lines: 90, branches: 82 }` — never lower them; raise in Task 3 if measured margin exceeds ~2 points (repo convention).
- Reference implementation for all patterns: `packages/plugin-prometheus/src/index.ts` (lines 14, 163, 257-291) and `packages/plugin-prometheus/test/prometheus.test.ts` (mockOrchestrator with `getFleetHealth`).
- Core types (from `@goopil/clusterkit`): `WorkerHealthReport = { workerId: number; pid: number; rss: number; heapUsed: number; eventLoopLagMs: number }`, `RecycleReason = "maxAge" | "rss" | "wedged"`, `FleetHealth = { target: number; active: number; quarantined: number; breaker: { count: number; tripped: boolean } }`, `fleet:recovered` payload `{ target: number; active: number; degradedDurationMs: number }`.

---

### Task 1: Per-worker health gauges (map + worker:health/worker:exit bindings)

**Files:**
- Modify: `packages/plugin-otlp-meter/src/index.ts`
- Test: `packages/plugin-otlp-meter/test/otlp-meter.test.ts`

**Interfaces:**
- Consumes: existing `PrimaryEvent` union (line 14), `primaryListeners` array (line 62), `clearPrimaryListeners()` (line 64), existing `bind()` helper inside `install()` (line 191), mocked exporters in the test file (lines 16-40).
- Produces: typed `bind<E extends PrimaryEvent>(event: E, listener: (...args: OrchestratorEvents[E]) => void)`; factory-scoped `workerHealth: Map<number, WorkerHealthSample>` where `WorkerHealthSample = { pid: number; rss: number; heapUsed: number; eventLoopLagMs: number; lastBeatAt: number }`; 4 observable gauges (`worker.rss_bytes`, `worker.heap_used_bytes`, `worker.eventloop_lag_ms`, `worker.heartbeat_age_seconds`) with attributes `worker.id` (number) and `process.pid` (number); test helpers `capturedExports: unknown[]` and `findPoints(metricName)`.

- [ ] **Step 1: Extend the test harness to capture exported payloads, then write the failing tests**

In `test/otlp-meter.test.ts`:

1a. Add a hoisted capture array next to `exporterCtorArgs` (line ~11):

```ts
const capturedExports = vi.hoisted(() => [] as unknown[]);
```

1b. In BOTH mocked exporter classes (http at line ~21, grpc at line ~33), change `export` to record the payload:

```ts
    async export(metrics: unknown, cb: (r: { status: number }) => void) {
      capturedExports.push(metrics);
      cb({ status: 0 });
    },
```

1c. In `beforeEach` (line ~50), add `capturedExports.length = 0;`.

1d. Add these helpers after `spyOnCounters` (line ~147):

```ts
type HealthDataPoint = { attributes: Record<string, string | number>; value: number };

/** Collect the data points observed for a metric name across all captured export batches. */
function findPoints(metricName: string): HealthDataPoint[] {
  for (const batch of capturedExports) {
    const { scopeMetrics } = batch as {
      scopeMetrics?: Array<{ metrics?: Array<{ descriptor: { name: string }; dataPoints?: HealthDataPoint[] }> }>;
    };
    for (const scope of scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        if (metric.descriptor.name === metricName) return metric.dataPoints ?? [];
      }
    }
  }
  return [];
}
```

1e. Add a new describe block after the existing `describe("metrics — event to counter mapping", ...)` block (ends at line ~297):

```ts
describe("metrics — worker health gauges", () => {
  it("worker:health populates per-worker gauges with worker.id and process.pid attributes", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:health", { workerId: 7, pid: 7007, rss: 1000, heapUsed: 500, eventLoopLagMs: 12 });
    emit(orch, "worker:health", { workerId: 8, pid: 8008, rss: 2000, heapUsed: 900, eventLoopLagMs: 34 });

    await plugin.meterProvider!.forceFlush();

    expect(findPoints("clusterkit.worker.rss_bytes")).toEqual([
      { attributes: { "worker.id": 7, "process.pid": 7007 }, value: 1000 },
      { attributes: { "worker.id": 8, "process.pid": 8008 }, value: 2000 },
    ]);
    expect(findPoints("clusterkit.worker.heap_used_bytes")).toEqual([
      { attributes: { "worker.id": 7, "process.pid": 7007 }, value: 500 },
      { attributes: { "worker.id": 8, "process.pid": 8008 }, value: 900 },
    ]);
    expect(findPoints("clusterkit.worker.eventloop_lag_ms")).toEqual([
      { attributes: { "worker.id": 7, "process.pid": 7007 }, value: 12 },
      { attributes: { "worker.id": 8, "process.pid": 8008 }, value: 34 },
    ]);

    await plugin.uninstall?.(orch);
  });

  it("worker.heartbeat_age_seconds grows with time since the last heartbeat", async () => {
    vi.useFakeTimers();
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:health", { workerId: 3, pid: 3003, rss: 1, heapUsed: 1, eventLoopLagMs: 1 });
    vi.advanceTimersByTime(60_000);

    await plugin.meterProvider!.forceFlush();
    expect(findPoints("clusterkit.worker.heartbeat_age_seconds")).toEqual([
      { attributes: { "worker.id": 3, "process.pid": 3003 }, value: 60 },
    ]);

    await plugin.uninstall?.(orch);
    vi.useRealTimers();
  });

  it("worker:exit stops emitting the worker's series", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:health", { workerId: 9, pid: 9009, rss: 1, heapUsed: 2, eventLoopLagMs: 3 });
    emit(orch, "worker:exit", { workerId: 9, pid: 9009, code: 0, signal: null, graceful: true });
    await plugin.meterProvider!.forceFlush();

    expect(findPoints("clusterkit.worker.rss_bytes")).toEqual([]);

    await plugin.uninstall?.(orch);
  });

  it("uninstall clears health state so a reinstall starts fresh", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:health", { workerId: 5, pid: 5005, rss: 10, heapUsed: 20, eventLoopLagMs: 30 });
    await plugin.uninstall?.(orch);
    await plugin.install(orch, null, singleWorkerConfig());

    await plugin.meterProvider!.forceFlush();
    expect(findPoints("clusterkit.worker.rss_bytes")).toEqual([]);

    await plugin.uninstall?.(orch);
  });
});
```

Note: `mockOrchestrator` currently lacks `getFleetHealth` — Task 2 extends it; not needed here.

- [ ] **Step 2: Run tests to verify they fail**

```bash
source ~/.nvm/nvm.sh && nvm use
corepack pnpm --filter @goopil/clusterkit-otlp-meter exec vitest run test/otlp-meter.test.ts -t "worker health gauges"
```

Expected: the 4 new tests FAIL (gauges never observed → `findPoints` returns `[]` / values missing).

- [ ] **Step 3: Implement in `src/index.ts`**

3a. Extend the `@goopil/clusterkit` import (line 4) with `type OrchestratorEvents`, and the `@opentelemetry/api` import (line 5) with `type ObservableResult`:

```ts
import {
  type Logger,
  type Orchestrator,
  type OrchestratorEvents,
  type ResolvedConfig,
  withLoggerPrefix,
} from "@goopil/clusterkit";
import { metrics, type ObservableResult } from "@opentelemetry/api";
```

3b. Extend the `PrimaryEvent` union (line 14):

```ts
type PrimaryEvent =
  | "worker:crash"
  | "worker:restart"
  | "circuit-breaker:tripped"
  | "worker:health"
  | "worker:exit";
```

3c. Add the sample type + factory-scoped map, and switch the listeners array to payload-agnostic typing (replacing line 62, mirroring `plugin-prometheus/src/index.ts:161-163`):

```ts
interface WorkerHealthSample {
  pid: number;
  rss: number;
  heapUsed: number;
  eventLoopLagMs: number;
  lastBeatAt: number;
}

// Listeners stored payload-agnostic; the concrete payload type is inferred at
// the bind() call site via OrchestratorEvents[E].
const primaryListeners: Array<{ event: PrimaryEvent; listener: (...args: never[]) => void }> = [];
```

3d. Replace the existing `bind` helper inside `install()` (line ~191) with the typed version:

```ts
        const bind = <E extends PrimaryEvent>(event: E, listener: (...args: OrchestratorEvents[E]) => void): void => {
          orchestrator.on(event, listener);
          primaryListeners.push({ event, listener });
        };
```

3e. After the existing `circuit_breaker.trips` counter declarations (line ~189), add the health gauges and their callbacks:

```ts
        const workerRssGauge = meter.createObservableGauge(`${prefix}worker.rss_bytes`, {
          description: "Resident set size per worker from health heartbeats",
          unit: "By",
        });
        const workerHeapGauge = meter.createObservableGauge(`${prefix}worker.heap_used_bytes`, {
          description: "V8 heap used per worker from health heartbeats",
          unit: "By",
        });
        const workerLagGauge = meter.createObservableGauge(`${prefix}worker.eventloop_lag_ms`, {
          description: "Event loop lag per worker from health heartbeats",
          unit: "ms",
        });
        const workerHeartbeatAgeGauge = meter.createObservableGauge(`${prefix}worker.heartbeat_age_seconds`, {
          description: "Seconds since the last health heartbeat per worker",
          unit: "s",
        });

        const observeWorkerHealth = (
          result: ObservableResult<number>,
          pick: (sample: WorkerHealthSample) => number,
        ): void => {
          for (const [workerId, sample] of workerHealth) {
            result.observe(pick(sample), { "worker.id": workerId, "process.pid": sample.pid });
          }
        };

        workerRssGauge.addCallback((result) => observeWorkerHealth(result, (s) => s.rss));
        workerHeapGauge.addCallback((result) => observeWorkerHealth(result, (s) => s.heapUsed));
        workerLagGauge.addCallback((result) => observeWorkerHealth(result, (s) => s.eventLoopLagMs));
        workerHeartbeatAgeGauge.addCallback((result) => {
          const now = Date.now();
          observeWorkerHealth(result, (s) => Math.max(0, (now - s.lastBeatAt) / 1000));
        });
```

3f. After the existing three `bind(...)` calls (line ~204), add:

```ts
        bind("worker:health", ({ workerId, pid, rss, heapUsed, eventLoopLagMs }) => {
          workerHealth.set(workerId, { pid, rss, heapUsed, eventLoopLagMs, lastBeatAt: Date.now() });
        });
        bind("worker:exit", ({ workerId }) => {
          workerHealth.delete(workerId);
        });
```

3g. In `uninstall()` (line ~223), add the map clear right after `clearPrimaryListeners();`:

```ts
      workerHealth.clear();
```

- [ ] **Step 4: Run the full package suite and typecheck the build**

```bash
corepack pnpm --filter @goopil/clusterkit-otlp-meter test
corepack pnpm --filter @goopil/clusterkit-otlp-meter build
```

Expected: all tests pass (45 existing + 4 new = 49), build succeeds (typecheck).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-otlp-meter/src/index.ts packages/plugin-otlp-meter/test/otlp-meter.test.ts
git commit -m "feat(plugin-otlp-meter): per-worker health gauges from heartbeats"
```

---

### Task 2: Recycle/wedged counters, fleet gauges, recovery duration

**Files:**
- Modify: `packages/plugin-otlp-meter/src/index.ts`
- Test: `packages/plugin-otlp-meter/test/otlp-meter.test.ts`

**Interfaces:**
- Consumes: Task 1's typed `bind`, `PrimaryEvent` union, `findPoints`/`capturedExports` helpers, `spyOnCounters()` (existing, line 121 — spies on `counter.add`, so attribute assertions use `toHaveBeenCalledWith(1, { reason: "..." })`).
- Produces: counters `worker.recycles` (attr `reason`), `worker.wedged.kills`; sync gauge `recovery.duration_seconds` (seconds); observable gauges `fleet.target_workers`, `fleet.active_workers`, `fleet.quarantined_slots` reading `orchestrator.getFleetHealth()`.

- [ ] **Step 1: Extend `mockOrchestrator` in the test file with `getFleetHealth`, then write the failing tests**

1a. Update `mockOrchestrator` (line ~58) — add the `quarantined` field and `getFleetHealth()` (mirroring `packages/plugin-prometheus/test/prometheus.test.ts:13-32`), and add `FleetHealth` to the type import from `@goopil/clusterkit` (line 3):

```ts
import type { FleetHealth, Logger, Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
```

```ts
function mockOrchestrator(activeWorkers = 0, workerCount = 0): Orchestrator {
  const emitter = new EventEmitter() as EventEmitter & {
    currentActiveWorkers: number;
    getMetrics: () => { activeWorkers: number };
    workerCount: number;
    quarantined: number;
    getFleetHealth: () => FleetHealth;
    registerOnShutdown: (cb: () => void | Promise<void>) => void;
  };
  emitter.currentActiveWorkers = activeWorkers;
  emitter.getMetrics = () => ({ activeWorkers: emitter.currentActiveWorkers });
  emitter.workerCount = workerCount;
  emitter.quarantined = 0;
  emitter.getFleetHealth = () => ({
    target: emitter.workerCount,
    active: emitter.currentActiveWorkers,
    quarantined: emitter.quarantined,
    breaker: { count: 0, tripped: false },
  });
  emitter.registerOnShutdown = () => {};
  return emitter as unknown as Orchestrator;
}
```

1b. Add a describe block after Task 1's block:

```ts
describe("metrics — recovery and fleet", () => {
  it("worker:recycle increments worker.recycles with the reason attribute", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:recycle", { workerId: 1, pid: 1, ageMs: 0, reason: "rss" });
    emit(orch, "worker:recycle", { workerId: 2, pid: 2, ageMs: 0, reason: "maxAge" });
    emit(orch, "worker:recycle", { workerId: 3, pid: 3, ageMs: 0, reason: "wedged" });

    expect(spies["clusterkit.worker.recycles"]).toHaveBeenCalledWith(1, { reason: "rss" });
    expect(spies["clusterkit.worker.recycles"]).toHaveBeenCalledWith(1, { reason: "maxAge" });
    expect(spies["clusterkit.worker.recycles"]).toHaveBeenCalledWith(1, { reason: "wedged" });

    restore();
    await plugin.uninstall?.(orch);
  });

  it("worker:wedged increments worker.wedged.kills", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "worker:wedged", { workerId: 4, pid: 4, silentMs: 5000 });

    expect(spies["clusterkit.worker.wedged.kills"]).toHaveBeenCalledTimes(1);

    restore();
    await plugin.uninstall?.(orch);
  });

  it("fleet gauges observe live getFleetHealth() values", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator(2, 2);
    await plugin.install(orch, null, singleWorkerConfig());

    (orch as unknown as { currentActiveWorkers: number }).currentActiveWorkers = 1;
    (orch as unknown as { quarantined: number }).quarantined = 1;

    await plugin.meterProvider!.forceFlush();

    expect(findPoints("clusterkit.fleet.active_workers")).toEqual([{ attributes: {}, value: 1 }]);
    expect(findPoints("clusterkit.fleet.target_workers")).toEqual([{ attributes: {}, value: 2 }]);
    expect(findPoints("clusterkit.fleet.quarantined_slots")).toEqual([{ attributes: {}, value: 1 }]);

    await plugin.uninstall?.(orch);
  });

  it("fleet:recovered records recovery.duration_seconds", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());

    emit(orch, "fleet:recovered", { target: 2, active: 2, degradedDurationMs: 4321 });

    await plugin.meterProvider!.forceFlush();

    expect(findPoints("clusterkit.recovery.duration_seconds")).toEqual([{ attributes: {}, value: 4.321 }]);

    await plugin.uninstall?.(orch);
  });

  it("no recycle listeners fire after uninstall", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const { spies, restore } = await spyOnCounters();
    const plugin = createOtlpMeterPlugin({ instrumentation: false, exportIntervalMs: 1000 });
    const orch = mockOrchestrator();
    await plugin.install(orch, null, singleWorkerConfig());
    await plugin.uninstall?.(orch);

    emit(orch, "worker:recycle", { workerId: 1, pid: 1, ageMs: 0, reason: "rss" });

    expect(spies["clusterkit.worker.recycles"]).not.toHaveBeenCalled();

    restore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
corepack pnpm --filter @goopil/clusterkit-otlp-meter exec vitest run test/otlp-meter.test.ts -t "recovery and fleet"
```

Expected: the 5 new tests FAIL (no such counters/gauges; spies undefined).

- [ ] **Step 3: Implement in `src/index.ts`**

3a. Extend `PrimaryEvent` (Task 1 version) with the three remaining events:

```ts
type PrimaryEvent =
  | "worker:crash"
  | "worker:restart"
  | "circuit-breaker:tripped"
  | "worker:health"
  | "worker:exit"
  | "worker:recycle"
  | "worker:wedged"
  | "fleet:recovered";
```

3b. After the health gauge callbacks from Task 1, add the counters, sync gauge, and fleet gauges:

```ts
        const workerRecyclesCounter = meter.createCounter(`${prefix}worker.recycles`, {
          description: "Total number of worker recycles by reason",
        });
        const wedgedKillsCounter = meter.createCounter(`${prefix}worker.wedged.kills`, {
          description: "Total number of workers killed for being unresponsive",
        });
        const recoveryDurationGauge = meter.createGauge(`${prefix}recovery.duration_seconds`, {
          description: "Duration of the last fleet degraded-to-recovered cycle",
          unit: "s",
        });

        const fleetTargetGauge = meter.createObservableGauge(`${prefix}fleet.target_workers`, {
          description: "Target worker count (live fleet health)",
        });
        const fleetActiveGauge = meter.createObservableGauge(`${prefix}fleet.active_workers`, {
          description: "Currently active workers (live fleet health)",
        });
        const fleetQuarantinedGauge = meter.createObservableGauge(`${prefix}fleet.quarantined_slots`, {
          description: "Quarantined worker slots (live fleet health)",
        });

        fleetTargetGauge.addCallback((result) => {
          result.observe(orchestrator.getFleetHealth().target);
        });
        fleetActiveGauge.addCallback((result) => {
          result.observe(orchestrator.getFleetHealth().active);
        });
        fleetQuarantinedGauge.addCallback((result) => {
          result.observe(orchestrator.getFleetHealth().quarantined);
        });
```

3c. Extend the bindings:

```ts
        bind("worker:recycle", ({ reason }) => {
          workerRecyclesCounter.add(1, { reason });
        });
        bind("worker:wedged", () => {
          wedgedKillsCounter.add(1);
        });
        bind("fleet:recovered", ({ degradedDurationMs }) => {
          recoveryDurationGauge.record(degradedDurationMs / 1000);
        });
```

- [ ] **Step 4: Run the full package suite and typecheck the build**

```bash
corepack pnpm --filter @goopil/clusterkit-otlp-meter test
corepack pnpm --filter @goopil/clusterkit-otlp-meter build
```

Expected: all tests pass (49 + 5 = 54), build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-otlp-meter/src/index.ts packages/plugin-otlp-meter/test/otlp-meter.test.ts
git commit -m "feat(plugin-otlp-meter): recycle/wedged counters, fleet gauges, recovery duration"
```

---

### Task 3: Docs, changeset, coverage floors, full validation

**Files:**
- Modify: `packages/plugin-otlp-meter/README.md` (metric list, around line 109)
- Modify: `packages/plugin-otlp-meter/vitest.config.ts` (only if floors need raising)
- Create: `.changeset/<random-name>.md` (use `corepack pnpm changeset` or write the file directly)

**Interfaces:**
- Consumes: the 9 new metric names from Tasks 1-2.
- Produces: user-facing docs, release changeset.

- [ ] **Step 1: Update the README metric list**

In `packages/plugin-otlp-meter/README.md`, extend the bullet list at line ~109 (keep the existing bullets, add the new ones grouped the same way):

```markdown
- `clusterkit.active_workers` (ObservableGauge)
- `clusterkit.worker.restarts` (Counter)
- `clusterkit.worker.crashes` (Counter)
- `clusterkit.circuit_breaker.trips` (Counter)
- `clusterkit.worker.rss_bytes` (ObservableGauge, attributes `worker.id`, `process.pid`)
- `clusterkit.worker.heap_used_bytes` (ObservableGauge, attributes `worker.id`, `process.pid`)
- `clusterkit.worker.eventloop_lag_ms` (ObservableGauge, attributes `worker.id`, `process.pid`)
- `clusterkit.worker.heartbeat_age_seconds` (ObservableGauge, attributes `worker.id`, `process.pid`)
- `clusterkit.worker.recycles` (Counter, attribute `reason`: rss / maxAge / wedged)
- `clusterkit.worker.wedged.kills` (Counter)
- `clusterkit.fleet.active_workers` (ObservableGauge)
- `clusterkit.fleet.target_workers` (ObservableGauge)
- `clusterkit.fleet.quarantined_slots` (ObservableGauge)
- `clusterkit.recovery.duration_seconds` (Gauge)
```

After the list, append this sentence to the paragraph:

```markdown
Worker-sourced series (`worker.rss_bytes`, `worker.heap_used_bytes`, `worker.eventloop_lag_ms`,
`worker.heartbeat_age_seconds`) only appear when core health monitoring is enabled and
heartbeats flow; the fleet gauges and event counters report regardless.
```

- [ ] **Step 2: Add the changeset**

```bash
corepack pnpm changeset
```

Select `@goopil/clusterkit-otlp-meter`, bump type `minor`, summary:

```
feat: health, fleet and recovery metrics — per-worker rss/heap/eventloop lag/heartbeat age gauges from health heartbeats, recycle counts by reason, wedged kills, live fleet gauges (active/target/quarantined) and recovery.duration_seconds, matching the Prometheus plugin's metric set
```

(Alternatively write the `.changeset/*.md` file directly with the standard frontmatter format.)

- [ ] **Step 3: Measure coverage and adjust floors**

```bash
corepack pnpm --filter @goopil/clusterkit-otlp-meter exec vitest run --coverage --coverage.reporter=text
```

If `src/index.ts` measured values exceed the floors (`lines: 90, branches: 82`) by more than ~2 points, raise the floors to `measured - 2` (rounded down). Never lower a floor.

- [ ] **Step 4: Full validation**

```bash
corepack pnpm --filter @goopil/clusterkit-otlp-meter test
corepack pnpm lint
corepack pnpm test:packages
```

Expected: package suite green, `biome check .` exit 0 (pre-existing warnings acceptable), packaging smoke passes.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-otlp-meter/README.md packages/plugin-otlp-meter/vitest.config.ts .changeset/
git commit -m "docs(plugin-otlp-meter): document new metrics and add changeset"
```
