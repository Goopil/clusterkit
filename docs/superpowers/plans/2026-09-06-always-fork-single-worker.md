# Always Fork, Even for a Single Worker (2.0) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At `workers.count: 1`, always fork one worker — the app runs in the worker, the primary is a pure supervisor — and delete every single-worker special case (core, signal-restart plugin, file-watcher plugin).

**Architecture:** `runPrimary()` unconditionally calls `startPrimary(workerCount)`; `startSingleWorkerPrimary`/`shutdownSingleWorker` and the #170 health warnings are deleted. `restartWorkers()` rolls the single worker like any other. The two hot-restart plugins lose their count-1 branches. Spec: `docs/superpowers/specs/2026-09-06-always-fork-single-worker-design.md`.

**Tech Stack:** TypeScript, vitest (mocked `clusterModule` harness), tsdown/turbo build, biome lint, changesets.

## Global Constraints

- Worktree: `/Users/zacharyvolpi/dev/perso/nodejs-multi-worker/.worktrees/feat-always-fork`, branch `feat/always-fork-single-worker`.
- Before ANY command: `source ~/.nvm/nvm.sh && nvm use` (Node 22 via `.nvmrc`). Package manager: `corepack pnpm`, never bare `pnpm`.
- No new dependencies. No manual peer-dependency edits (plugins use `workspace:^`; pnpm rewrites at publish).
- All code, comments, tests, docs in English. Match existing file style; do not add comments unless essential.
- Coverage floors are never lowered; raise only per repo convention (measured margin > ~2 points).
- Commit style follows repo history (`feat(scope): ...`, `test(scope): ...`, `docs: ...`).
- Tests-first: rewrite/red tests before deleting implementation.

---

### Task 1: Core — always fork at count 1

**Files:**
- Modify: `packages/worker-manager/src/orchestrator.ts` (lines ~273-284 `runPrimary`, ~657-725 single-worker section, ~474-476 restart early return)
- Modify: `packages/worker-manager/test/orchestrator.test.ts` (describe blocks at lines 673-788)

**Interfaces:**
- Consumes: existing `MockCluster`/`MockWorker` harness, `cfg()` helper, `reportHealth()` helper in `test/orchestrator.test.ts`.
- Produces: `run()` at `workers: 1` forks exactly one worker; `restartWorkers()` works at count 1 (Task 2 builds on this file).

- [ ] **Step 1: Rewrite the single-worker test block to expect fork behavior (red)**

Replace the whole `describe("run() — single-worker mode (workers = 1)", ...)` block (lines 673-788, including the nested "health policy warnings" describe) with:

```ts
  describe("run() — single worker (workers = 1)", () => {
    it("forks exactly one worker — the app runs in the worker, not the primary", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 1 }));
      const start = vi.fn().mockResolvedValue(undefined);
      await orch.run(start);
      expect(start).not.toHaveBeenCalled();
      expect(Object.keys(mockCluster.workers)).toHaveLength(1);
    });

    it("tracks the single worker and emits worker:online", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 1 }));
      const events: unknown[] = [];
      orch.on("worker:online", (data) => events.push(data));
      await orch.run(() => {});
      await new Promise<void>((r) => setImmediate(r));
      expect(orch.getMetrics().activeWorkers).toBe(1);
      expect(events).toHaveLength(1);
    });

    it("registers signal handlers before forking (same #93 guarantee as multi-worker)", async () => {
      mockCluster.isPrimary = true;
      const onSpy = vi.spyOn(process, "on");
      const forkSpy = vi.spyOn(mockCluster, "fork");
      const orch = new Orchestrator(cfg({ workers: 1 }));
      await orch.run(() => {});
      const sigtermIdx =
        onSpy.mock.invocationCallOrder[onSpy.mock.calls.findIndex(([signal]) => signal === "SIGTERM")];
      expect(sigtermIdx).toBeLessThan(forkSpy.mock.invocationCallOrder[0]);
    });

    it("SIGTERM drains the single worker and completes shutdown", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 1 }));
      await orch.run(() => {});
      const events: string[] = [];
      orch.on("shutdown:start", () => events.push("start"));
      orch.on("shutdown:complete", () => events.push("complete"));

      process.emit("SIGTERM", "SIGTERM");
      await vi.waitFor(() => expect(events).toEqual(["start", "complete"]));
      expect(orch.getHealth().ready).toBe(false);
    });

    it("health heartbeats flow at count 1 (no more blind spot)", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 1, health: { heartbeatMs: 1000 } }));
      await orch.run(() => {});
      reportHealth(orch, 1, 1001, 50);
      // The heartbeat reached the monitor: one worker tracked by the health registry.
      const tracked = (orch as unknown as { healthMonitor: { health: Map<number, unknown> } }).healthMonitor.health;
      expect(tracked.size).toBe(1);
    });

    it("worker crash triggers a restart with the single worker forked back", async () => {
      mockCluster.isPrimary = true;
      const orch = new Orchestrator(cfg({ workers: 1, restart: { backoffMs: 100, maxBackoffMs: 100 } }));
      const restarted: unknown[] = [];
      orch.on("worker:restart", (d) => restarted.push(d));
      await orch.run(() => {});
      await new Promise<void>((r) => setImmediate(r));

      const worker = Object.values(mockCluster.workers)[0];
      worker.simulateCrash(1, null);

      await vi.waitFor(() => expect(Object.keys(mockCluster.workers)).toHaveLength(2), { timeout: 3000 });
      expect(restarted).toHaveLength(1);
    });
  });
```

Notes:
- If the private `healthMonitor` accessor name differs, read `packages/worker-manager/src/health-monitor.ts` first and adapt the accessor — the intent is "one worker is tracked by the health registry".
- `reportHealth()` already exists in the test file and routes through the real monitor tap.
- The shutdown test mirrors `shutdownPrimary()`'s real sequence; `process.exit` is already mocked in `beforeEach`.

- [ ] **Step 2: Run to verify the new tests fail**

```bash
source ~/.nvm/nvm.sh && nvm use
corepack pnpm --filter @goopil/clusterkit exec vitest run test/orchestrator.test.ts -t "single worker"
```

Expected: FAIL — current code never forks at count 1 (0 workers, start called directly).

- [ ] **Step 3: Delete the single-worker implementation**

In `src/orchestrator.ts`:

3a. In `runPrimary()`, remove the branch (lines ~275-280):

```ts
    // Single-worker mode: run directly in primary without forking
    if (workerCount === 1) {
      this.startSingleWorkerPrimary();
      await start?.();
      return;
    }
```

3b. Delete the entire single-worker section (lines ~657-725): the `// Single-worker mode (no fork ...)` header comment, `startSingleWorkerPrimary()`, and `shutdownSingleWorker()`.

3c. In `restartWorkers()`, remove the early return (lines ~474-476):

```ts
    if (this.workerCount === 1) {
      this.log?.warn("restartWorkers() called in single-worker mode — no cluster to roll", { reason });
      return;
    }
```

(The multi path never calls `start` — after 3a the `start` parameter of `runPrimary` becomes unused. Keep the public `run(start)` signature; remove only the unused parameter plumbing inside `runPrimary` if the typechecker or lint flags it.)

- [ ] **Step 4: Run the full core suite**

```bash
corepack pnpm --filter @goopil/clusterkit test
corepack pnpm --filter @goopil/clusterkit build
```

Expected: PASS, build green (typecheck).

- [ ] **Step 5: Commit**

```bash
git add packages/worker-manager/src/orchestrator.ts packages/worker-manager/test/orchestrator.test.ts
git commit -m "feat(core)!: always fork, even for a single worker (2.0)"
```

---

### Task 2: plugin-signal-restart — SIGHUP rolls the single worker

**Files:**
- Modify: `packages/plugin-signal-restart/src/index.ts` (lines ~55-65 `handleSignal`)
- Modify: `packages/plugin-signal-restart/test/signal-restart.test.ts` (lines ~94-120)
- Modify: `packages/plugin-signal-restart/test/signal-restart.integration.test.ts` (lines ~81-105)
- Modify: `packages/plugin-signal-restart/README.md` (single-worker mention)
- Create: `.changeset/<name>.md`

**Interfaces:**
- Consumes: Task 1's `restartWorkers()` that now works at count 1.
- Produces: SIGHUP at count 1 triggers `restartWorkers()` instead of self-SIGTERM.

- [ ] **Step 1: Rewrite the unit tests (red)**

Delete the tests `"sends SIGTERM to self in single-worker mode"` and `"sends SIGTERM to self when workers is 'auto' but resolves to a single worker"`. Add:

```ts
  it("rolls the single worker via restartWorkers at count 1", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator(1);
    const restartWorkers = (orch as unknown as { restartWorkers: ReturnType<typeof vi.fn> }).restartWorkers;

    await plugin.install(orch, null, mockConfig(1));

    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(restartWorkers).toHaveBeenCalledWith({ staggerMs: 1000, reason: "signal:SIGHUP" });
    await plugin.uninstall?.(orch);
  });

  it("rolls the single worker when workers is 'auto' and resolves to 1", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator(1);
    const restartWorkers = (orch as unknown as { restartWorkers: ReturnType<typeof vi.fn> }).restartWorkers;

    await plugin.install(orch, null, mockConfig("auto"));

    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(restartWorkers).toHaveBeenCalledOnce();
    await plugin.uninstall?.(orch);
  });
```

(Adapt `staggerMs`/`reason` to the existing mock's expectations — mirror the neighboring multi-worker restart test.)

- [ ] **Step 2: Run to verify red**

```bash
corepack pnpm --filter @goopil/clusterkit-signal-restart exec vitest run test/signal-restart.test.ts -t "rolls the single worker"
```

Expected: FAIL — plugin still sends self-SIGTERM at count 1.

- [ ] **Step 3: Delete the plugin branch**

In `src/index.ts` `handleSignal`, remove:

```ts
        if (orchestrator.workerCount === 1) {
          log?.info("Signal received in single-worker mode, exiting for external restart", {
            signal,
            reason,
          });
          process.kill(process.pid, "SIGTERM");
          return;
        }
```

- [ ] **Step 4: Rewrite the integration test**

Replace `"exits on SIGHUP in single-worker mode"` with a rolling-restart expectation: keep the setup (count 1, real cluster) but listen for `restart:complete` instead of `shutdown:complete`:

```ts
  it("rolls the single worker on SIGHUP at count 1", async () => {
    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: { count: 1 },
      shutdown: { timeoutMs: 4_000, ackTimeoutMs: 1_000, messagePrefix: PREFIX },
    });

    const plugin = createSignalRestartPlugin();
    orchestrator.use(plugin);
    await orchestrator.run();

    const restartP = once(orchestrator, "restart:complete");
    process.emit("SIGHUP");

    await Promise.race([restartP, new Promise((_, r) => setTimeout(() => r(new Error("restart timeout")), 8_000))]);

    expect(plugin.lastRestart).toBeInstanceOf(Date);
  }, 15_000);
```

Keep the original test's structure (fixture path, `once` import, exitSpy cleanup); delete assertions that no longer apply (`ready` false, `exit(0)`).

- [ ] **Step 5: Update README + changeset**

- In `packages/plugin-signal-restart/README.md`, replace the single-worker SIGTERM paragraph with: at count 1, SIGHUP now performs an in-process rolling restart (replacement forked before the old worker drains), matching multi-worker behavior. Requires clusterkit >= 2.0.
- Changeset (minor):

```bash
corepack pnpm changeset
```

Package `@goopil/clusterkit-signal-restart`, bump `minor`, summary:

```
feat: SIGHUP at count 1 now triggers an in-process rolling restart instead of exiting via SIGTERM (requires clusterkit 2.0)
```

- [ ] **Step 6: Run package suite + build**

```bash
corepack pnpm --filter @goopil/clusterkit-signal-restart test
corepack pnpm --filter @goopil/clusterkit-signal-restart build
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-signal-restart .changeset/
git commit -m "feat(plugin-signal-restart)!: SIGHUP at count 1 rolls the single worker"
```

---

### Task 3: plugin-file-watcher — watcher effective at count 1

**Files:**
- Modify: `packages/plugin-file-watcher/src/index.ts` (lines ~142-145)
- Modify: `packages/plugin-file-watcher/test/file-watcher.test.ts` (lines ~116-140)
- Modify: `packages/plugin-file-watcher/README.md` (single-worker mention)
- Create: `.changeset/<name>.md`

**Interfaces:**
- Consumes: Task 1's `restartWorkers()` at count 1.
- Produces: file changes trigger a rolling restart at count 1.

- [ ] **Step 1: Rewrite the no-op tests (red)**

Replace `"no-ops in single-worker mode"` (asserts `isWatching === false`) with:

```ts
  it("watches files at count 1 — rolling restarts work there now", async () => {
    Object.defineProperty(cluster, "isPrimary", { value: true, configurable: true });
    const plugin = createFileWatcherPlugin({ watch: ["./src"] });
    const orch = mockOrchestrator(1);

    await plugin.install(orch, null, mockConfig(1));

    expect(plugin.isWatching).toBe(true);
  });
```

Apply the same change to `"no-ops when workers is 'auto' but resolves to a single worker"` (assert `isWatching === true`).

- [ ] **Step 2: Run to verify red**

```bash
corepack pnpm --filter @goopil/clusterkit-file-watcher exec vitest run test/file-watcher.test.ts -t "count 1"
```

Expected: FAIL — plugin still no-ops at count 1.

- [ ] **Step 3: Delete the plugin branch**

In `src/index.ts`, remove:

```ts
      if (orchestrator.workerCount === 1) {
        log?.warn("file-watcher plugin has no effect in single-worker mode");
        return;
      }
```

- [ ] **Step 4: Update README + changeset**

- README: replace the single-worker limitation note with "the watcher is effective at every worker count (>= 1); changes trigger an in-process rolling restart".
- Changeset (minor) on `@goopil/clusterkit-file-watcher`: `feat: file/env watching is now effective at workers.count 1 (requires clusterkit 2.0)`.

- [ ] **Step 5: Run package suite + build + commit**

```bash
corepack pnpm --filter @goopil/clusterkit-file-watcher test
corepack pnpm --filter @goopil/clusterkit-file-watcher build
git add packages/plugin-file-watcher .changeset/
git commit -m "feat(plugin-file-watcher)!: watching is effective at count 1"
```

---

### Task 4: plugin-prometheus + plugin-otlp-meter — drop primary-is-the-worker assumptions

**Files:**
- Modify: `packages/plugin-prometheus/test/prometheus.test.ts` (describe "single-worker mode", lines ~582-625)
- Modify: `packages/plugin-prometheus/README.md` (single-worker mention)
- Modify: `packages/plugin-otlp-meter/README.md` (lines 17, 128-131)

**Interfaces:**
- Consumes: nothing new — mock-based tests.
- Produces: test suite and docs describing count-1 as "forked worker, aggregated primary metrics".

- [ ] **Step 1: Run both suites to see what breaks**

```bash
corepack pnpm --filter @goopil/clusterkit-prometheus test
corepack pnpm --filter @goopil/clusterkit-otlp-meter test
```

Expected: prometheus mock-based tests likely still pass (the plugin reads `orchestrator.getMetrics()` — the mock supplies the value). Only titles/comments encode the old semantics.

- [ ] **Step 2: Adjust prometheus test titles/comments (no behavioral change expected)**

- Rename `describe("single-worker mode", ...)` → `describe("single worker (count 1, forked)", ...)`.
- Rename `"sets active_workers to 1 when workerCount resolves to 1 (primary IS the worker)"` → `"sets active_workers to 1 when workerCount resolves to 1 (forked worker tracked by the primary)"`.
- Update the block header comment (`// Single-worker mode (cluster.isPrimary with no fork)`) to `// Single worker (count 1) — the worker is forked and tracked`.
- If any default-metrics test fails because it assumed no-fork behavior, fix the assumption, not the assertion target.

- [ ] **Step 3: Update plugin READMEs**

- `packages/plugin-prometheus/README.md`: wherever single-worker mode is described as "primary is the worker", rewrite to "at count 1 the app runs in a forked worker; the primary-side endpoint serves aggregated metrics as in multi-worker mode".
- `packages/plugin-otlp-meter/README.md` line 17: replace "(or primary in single-worker mode)" with worker-only phrasing.
- `packages/plugin-otlp-meter/README.md` lines 128-131: replace the paragraph with: "At `workers: 1`, the app runs in a forked worker like any other count; worker-sourced series appear as soon as heartbeats flow."

- [ ] **Step 4: Run both suites + build + commit**

```bash
corepack pnpm --filter @goopil/clusterkit-prometheus test
corepack pnpm --filter @goopil/clusterkit-prometheus build
corepack pnpm --filter @goopil/clusterkit-otlp-meter test
corepack pnpm --filter @goopil/clusterkit-otlp-meter build
git add packages/plugin-prometheus packages/plugin-otlp-meter
git commit -m "docs(plugin): drop primary-is-the-worker assumptions (count 1 forks)"
```

---

### Task 5: Docs, changesets, full validation

**Files:**
- Modify: `packages/worker-manager/README.md` (lines 135-138, 156; add migration section)
- Modify: `AGENTS.md` (testing guidance)
- Modify: `examples/hot-reload/README.md` (only if it documents single-worker behavior)
- Create: `.changeset/<name>.md` (core major)

**Interfaces:**
- Consumes: all prior tasks merged.
- Produces: release-ready docs and changeset; full CI-parity validation.

- [ ] **Step 1: Update the core README**

Replace lines 135-138 (the "All of these health features require forked workers..." paragraph) with:

```markdown
Health features work at every worker count: at `count: 1` a single worker is forked and reports heartbeats over IPC
exactly like a larger fleet. Since 2.0 there is no no-fork mode — the primary is always a supervisor and the app always
runs in a worker process.
```

Update line 156 comment:

```ts
orchestrator.isPrimary; // true in the primary (the supervisor), false in forked workers — incl. the app process at count 1
```

Add a `## Migration to 2.0` section (before "Runtime API"):

```markdown
## Migration to 2.0

- `workers.count: 1` now forks one worker instead of running the app in the primary. The primary is a pure supervisor:
  OOM/wedge of the app no longer kills the process tree — the worker is restarted with backoff and the crash-loop
  breaker. Budget ~30-50 MB extra RSS for the extra process.
- `orchestrator.isPrimary` is now `false` in the application process at count 1. Gate primary-only resources on
  `isPrimary` as you would in multi-worker mode.
- Health features (heartbeats, RSS recycling, wedged detection, fleet degradation) work at count 1 — the 1.x startup
  warnings are gone.
- SIGHUP (plugin-signal-restart) and file/env watching (plugin-file-watcher) trigger in-process rolling restarts at
  count 1.
- Debugging: attach the inspector to the worker process — Node auto-increments cluster worker inspector ports.
```

- [ ] **Step 2: Update AGENTS.md**

Replace the line "`workers: 1` is single-worker mode (no cluster fork); crash/restart behavior needs `workers >= 2`" with:

```markdown
- `workers: 1` forks a single worker (2.0+): health, crash/restart and hot-restart behavior are testable at every count.
```

- [ ] **Step 3: Check the hot-reload example README**

Read `examples/hot-reload/README.md`; if it documents the single-worker SIGHUP → exit behavior, update it to "SIGHUP triggers a rolling restart at any worker count". The example source needs no change (server binds in the run callback; reusePort handled via capabilities).

- [ ] **Step 4: Core changeset (major)**

```bash
corepack pnpm changeset
```

Package `@goopil/clusterkit`, bump `major`, summary:

```
feat!: always fork, even for a single worker — count: 1 forks one worker, the primary becomes a pure supervisor, health features and hot restarts work at every count
```

- [ ] **Step 5: Full validation (CI-parity)**

```bash
corepack pnpm build
corepack pnpm test
corepack pnpm lint
corepack pnpm test:packages
```

Expected: build green, all package tests green (Node 22), biome clean, packaging smoke passes.

- [ ] **Step 6: Commit**

```bash
git add packages/worker-manager/README.md AGENTS.md examples/hot-reload/README.md .changeset/
git commit -m "docs: v2 migration notes (always fork), AGENTS testing guidance, core changeset"
```

---

### Task 6: Remove vestigial count-1 branches in otlp-meter + prometheus (metrics double-count fix)

**Files:**
- Modify: `packages/plugin-otlp-meter/src/index.ts` (lines ~313-316)
- Modify: `packages/plugin-otlp-meter/test/otlp-meter.test.ts` (instrumentation block, lines ~631-651)
- Modify: `packages/plugin-prometheus/src/index.ts` (lines ~374-395)
- Modify: `packages/plugin-prometheus/test/prometheus.test.ts` (describe "single worker (count 1, forked)")
- Create: `.changeset/<name>.md` (one per plugin)

**Interfaces:**
- Consumes: Task 1's always-fork semantics — at count 1 the app runs in a forked worker; worker-side metric collection already exists for every count.
- Produces: no primary-side host/default-metrics collection at count 1; worker-only collection, identical to multi-worker.

**Context (review finding):** under always-fork, the otlp-meter's vestigial primary-side `startHostMetrics` at count 1 double-reports system-level metrics (`system.cpu.*`, `system.memory.*`) — two independent HostMetrics instruments with distinct `service.instance.id` push the same host to the collector. Prometheus's count-1 primary-side default-metrics branch adds an idle-primary series and a `singleWorker` seed that diverges from the multi-worker path.

- [ ] **Step 1: Rewrite tests to the new contract (red)**

In `packages/plugin-otlp-meter/test/otlp-meter.test.ts`, replace `"starts host metrics at count 1 when instrumentation is true"` with:

```ts
  it("does not start host metrics in the primary at count 1 — the forked worker collects them", async () => {
    const { createOtlpMeterPlugin } = await import("../src/index");
    const plugin = createOtlpMeterPlugin({ instrumentation: true, exportIntervalMs: 1000 });
    const orch = mockOrchestrator(1, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    expect(mockHostMetricsStart).not.toHaveBeenCalled();
    await plugin.uninstall?.(orch);
  });
```

Keep `"does not start host metrics when instrumentation is false"` unchanged.

In `packages/plugin-prometheus/test/prometheus.test.ts`, describe block `"single worker (count 1, forked)"`:

- Replace `"sets active_workers to 1 when workerCount resolves to 1 (forked worker tracked by the primary)"` with a live-state assertion (no seed):

```ts
  it("reads active_workers from live fleet state at count 1", async () => {
    const plugin = makePlugin();
    const orch = mockOrchestrator(1, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    const out = await plugin.getMetrics();
    expect(out).toMatch(metricLine("clusterkit_active_workers", 1));
  });
```

- Replace `"collects default process metrics in the primary in single-worker mode"` with:

```ts
  it("does not collect default process metrics in the primary at count 1 (the forked worker reports them)", async () => {
    const registry = new Registry();
    const plugin = createPrometheusPlugin({ defaultMetrics: true, registry });
    const orch = mockOrchestrator(0, 1);
    await plugin.install(orch, null, singleWorkerConfig());

    const out = await plugin.getMetrics();
    expect(out).not.toContain("process_cpu_user_seconds_total");
  });
```

- Delete `"does not re-register default metrics after uninstall and reinstall in single-worker mode"` and `"removes default metrics on uninstall and collects them again on reinstall"` (no primary-side default metrics exist anymore; the worker path keeps its own coverage).
- Apply the same live-state rewrite to `"sets active_workers to 1 when workers is 'auto' and resolves to 1"` (use `autoWorkerConfig()`).

- [ ] **Step 2: Run both suites to verify red**

```bash
source ~/.nvm/nvm.sh && nvm use
corepack pnpm --filter @goopil/clusterkit-otlp-meter exec vitest run test/otlp-meter.test.ts -t "does not start host metrics in the primary"
corepack pnpm --filter @goopil/clusterkit-prometheus exec vitest run test/prometheus.test.ts -t "count 1"
```

Expected: new/rewritten tests FAIL against the vestigial branches.

- [ ] **Step 3: Delete the vestigial branches**

In `packages/plugin-otlp-meter/src/index.ts`, delete (primary branch only):

```ts
        const singleWorker = orchestrator.workerCount === 1;
        if (singleWorker && instrumentation) {
          await startHostMetrics(meterProvider);
        }
```

In `packages/plugin-prometheus/src/index.ts`, delete the seed and the primary-side default-metrics block (lines ~374-395), leaving the unconditional `syncActiveWorkers();`:

```ts
        const singleWorker = orchestrator.workerCount === 1;
        if (singleWorker) {
          activeWorkers.set(1);
        } else {
          syncActiveWorkers();
        }
```
becomes:
```ts
        syncActiveWorkers();
```

and delete the entire `if (defaultMetrics && singleWorker && !defaultMetricsInstalled) { ... }` block plus its explanatory comment. Then check `defaultMetricsInstalled` / `installedDefaultMetricNames`: if `uninstall()` still references them, keep the declarations; if nothing else uses them, delete the declarations too.

- [ ] **Step 4: Run both suites + builds**

```bash
corepack pnpm --filter @goopil/clusterkit-otlp-meter test
corepack pnpm --filter @goopil/clusterkit-otlp-meter build
corepack pnpm --filter @goopil/clusterkit-prometheus test
corepack pnpm --filter @goopil/clusterkit-prometheus build
```

Expected: all green.

- [ ] **Step 5: Changesets (one per plugin, minor)**

- `@goopil/clusterkit-otlp-meter`: `fix: no longer collects host metrics in the primary at count 1 — system metrics were double-counted once count 1 forked (requires clusterkit 2.0)`
- `@goopil/clusterkit-prometheus`: `fix: no longer collects default process metrics in the primary at count 1 (the forked worker reports them, as in multi-worker mode)`

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-otlp-meter packages/plugin-prometheus .changeset/
git commit -m "fix(plugin): drop vestigial primary-side metric collection at count 1"
```
