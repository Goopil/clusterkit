# Worker Health & Recovery — Design

**Repo:** Goopil/clusterkit · **Base:** `origin/main` @ `51d4b17` (post-decomposition) · **Date:** 2026-09-04

## 1. Goals

Make dense multi-worker pods resilient: observe worker health (RSS, heap, event-loop lag), replace
unhealthy workers before they take the pod down (OOMKill, wedged event loop), expose fleet state for
k8s wiring, and measure crash-recovery speed. All opt-in, zero cost when disabled, zero new runtime
dependencies.

**Non-goals:** BPF reuseport distribution (killed in brainstorming: ingress SNAT + pod-level load
balancing make it worthless in k8s); restore-speed policy changes (pending recovery-benchmark data,
§4.6); warm spare workers (user boot cost dominates).

## 2. Architecture

One rule governs everything: **events rise for observability, calls cross for control.**

- **Internal coordination** = typed dependency callbacks between modules (the coordinator pattern
  already shipped in `restart-coordinator.ts` / `drain-coordinator.ts`). Internal modules never call
  `emit`.
- **Public surface** = the single existing Orchestrator EventEmitter. Public events exist **only**
  for state transitions and actionable decisions; internal mechanics (queue kicks, backoff
  rescheduling, heartbeat bookkeeping) emit nothing at all.
- New core module: `src/health-monitor.ts` (~200 lines): worker-side reporter, primary-side registry
  + policies. The Orchestrator wires it via deps and owns all emissions.

**Platform policy — Linux first, clean macOS fallback.** All seven features are functionally
platform-neutral (IPC, timers, SIGKILL, env vars are portable): everything works on macOS dev
machines. Linux-specific enrichment is documentation (cgroup-derived `maxRssMb` sizing recipe) and
verification (e2e chaos + reference benchmarks run in the Linux Docker harness only, following the
existing reuseport-assertion gating pattern). macOS never produces committed reference numbers.

## 3. Config surface (all opt-in, defaults off)

```ts
workers: { maxRssMb?: number }            // 0 = off (default). Recycle a worker above this RSS.
health: {
  heartbeatMs?: number                    // 0 = off (default). Worker health report interval.
  wedgedTimeoutMs?: number                // 0 = off (default). Kill after this much silence.
                                          // Requires heartbeatMs > 0 and >= 2 × heartbeatMs.
  degradedAfterMs?: number                // 0 = off (default). fleet:degraded hysteresis.
}
restart: { bootFailQuarantine?: number }  // 0 = off (default). Consecutive never-online deaths
                                          // before the slot stops being re-forked.
```

Validation: `wedgedTimeoutMs` requires `heartbeatMs > 0` and `>= 2 × heartbeatMs`; `maxRssMb > 0`;
`bootFailQuarantine >= 0`; `heartbeatMs >= 100` floor (protects the IPC channel).

## 4. Features

### 4.1 Worker heartbeat

Worker side (installed in `startWorker()`, where core code already runs in workers): unref'd
`setInterval(heartbeatMs)` → `process.send({ type: "<messagePrefix>:hb", rss, heapUsed,
eventLoopLagMs })`. `eventLoopLagMs` = beat drift (now − lastBeat − heartbeatMs, floored at 0) —
missed beats under a wedged loop **are** the wedged signal (§4.4). Sends are guarded (the channel
closes during drain).

Primary side: `HealthMonitor` registry keyed by worker id (`{pid, lastReport, report}`), populated
through a third WorkerManager event callback (`worker.on("message")`), cleaned on worker exit.

### 4.2 Fleet health

`getFleetHealth(): { target, active, quarantined, breaker: { count, tripped } }` — computed from
WorkerManager state + CrashTracker. Events with hysteresis: `fleet:degraded` when
`active < target` persists ≥ `degradedAfterMs`; `fleet:recovered` when back to target, carrying
`degradedDurationMs` (measured by the core — recovery is a first-class number in prod, comparable to
bench numbers). No degraded events while a shutdown is in progress. k8s readiness → polling;
alerting/plugins → events.

### 4.3 RSS recycling (`workers.maxRssMb`)

On a heartbeat report with `rss > maxRssMb` → `WorkerManager.recycleWorkerNow(workerId, "rss")`:
mark, fork replacement immediately, then the existing `handleWorkerRecycle` path — the bounded drain
(IPC shutdown + ACK → disconnect → SIGTERM at `shutdown.timeoutMs` → SIGKILL after the signal
delays). **Does not count as a crash** (no breaker impact). One-shot per worker instance. Skipped
during shutdown. Rationale: a pod-level OOMKill kills every worker and every connection; sacrificing
the bloated worker keeps the pod serving — the sibling of `maxAgeMs`, on a different signal.

### 4.4 Wedged-worker kill (`health.wedgedTimeoutMs`)

If a worker that has **reported at least once** (first-report precondition: a slow-booting worker is
not wedged) goes silent > `wedgedTimeoutMs` while alive and not draining → emit `worker:wedged`,
then route through the **same bounded drain** as every other recycle (graceful attempt first). A
starved-but-alive worker may still process the shutdown message and die cleanly (no false-positive
kill); a genuinely wedged loop ignores IPC and SIGTERM handlers, so the ladder converges to SIGKILL
at the end of the budget — guaranteed. Cost: one drain budget (~2–3.5 s) of continued non-accepting
socket, deemed acceptable against false positives.

### 4.5 Boot-loop quarantine (`restart.bootFailQuarantine`)

Track consecutive boot-failures (crash **before** first `online`; the Orchestrator classifies via a
`onlineWorkerIds` set and passes `bootFailed` into `RestartCoordinator.onWorkerCrash`). Any
successful boot resets the streak. When streak ≥ N **while at least one worker is online** (the app
boots elsewhere) → quarantine: stop re-forking those slots, emit `worker:quarantined`; quarantined
slots appear in `getFleetHealth()`. Quarantined boot-failures do **not** count toward the fleet
breaker (one bad slot must not poison the fleet). Streak ≥ N with zero workers online → current
behavior (fleet-wide backoff + breaker), by design. Reset: `restartWorkers()` clears quarantine.

### 4.6 Recovery benchmark

New harness scenario (lifecycle mode, not an autocannon workload): boot a clusterkit target, warm
up, `SIGKILL` half the fleet, record time-to-full-capacity (poll pid-tagged responses until the
expected distinct-pid count is restored) plus boot-time per replacement. **Measure first**:
restore-speed policies (instant first restart, bounded parallel respawn) become a follow-up chantier
only if the data justifies it (audit: "ne pas changer sans mesure"). Also captures the
NODE_COMPILE_CACHE boot delta (§4.7). Results: Docker reference mode, committed. Baseline-first: run
on clean `main` before any feature lands.

### 4.7 NODE_COMPILE_CACHE (plugin-container-sizing)

Option `compileCache?: boolean | string` (default `false`) → injects `NODE_COMPILE_CACHE` (env-only
setting — not a CLI flag, so direct `workers.env` injection, not `NODE_OPTIONS`) into worker env;
`true` → `os.tmpdir()/clusterkit-compile-cache`, string → custom dir. Docs: tmpfs in containers,
content-hash invalidation, concurrent-safe atomic writes. The package engine floor is Node ≥ 22.12,
so no version guard is needed (YAGNI). Measured with the recovery bench (§4.6); dropped if the boot
delta is not demonstrably positive.

## 5. Public API surface

Existing `worker:recycle` payload **gains** `reason` (additive, non-breaking):
`{ workerId, pid, ageMs, reason: "maxAge" | "rss" | "wedged" }`.

| Event | Payload | Emitted when |
|---|---|---|
| `worker:recycle` | `{ workerId, pid, ageMs, reason }` | recycle decision (existing event, extended) |
| `worker:health` | `{ workerId, pid, rss, heapUsed, eventLoopLagMs }` | each report |
| `worker:wedged` | `{ workerId, pid, silentMs }` | before the drain starts |
| `worker:quarantined` | `{ consecutiveBootFailures }` | slot quarantined |
| `fleet:degraded` | `{ target, active }` | hysteresis elapsed |
| `fleet:recovered` | `{ target, active, degradedDurationMs }` | back at target |

Plus `getFleetHealth()`, the config fields above, and payload types exported from `types.ts`. Every
event documented in README (existing convention). Rule: transitions public, mechanics silent. Future
promotion of an internal signal → public event via changeset, never the reverse.

## 6. Testing strategy — three layers, platform matrix

### Layer 1 — Unit (fast, hermetic, fake timers, mock workers)

| Under test | Pinned behaviors |
|---|---|
| `test/health-monitor.test.ts` | report registry (set/clear on exit), lag calculation, RSS trigger + one-shot + shutdown/restart guards, wedged timer (first-report precondition, N consecutive misses, no kill while draining), validation cross-fields |
| `test/restart-coordinator.test.ts` (ext.) | boot-fail streak accounting, quarantine decision (online-guard true/false), no breaker counting while quarantining, reset by `restartWorkers()`, disabled when `bootFailQuarantine: 0` |
| `test/orchestrator.test.ts` (ext.) | event emission at transitions only, payload shapes (`reason` on `worker:recycle`), hysteresis timing, `getFleetHealth()` numbers, no `fleet:degraded` during shutdown |
| `test/validation.test.ts` (ext.) | new options, ranges, cross-field rules, off-by-default |
| `plugin-container-sizing/test` (ext.) | `compileCache` injection, NODE_OPTIONS untouched, off by default |

### Layer 2 — Integration (real `cluster.fork`, real IPC, real signals — in vitest)

Fixture worker `test/fixtures/health-worker.mjs` controlled by env flags: `CKX_CRASH_AT_BOOT=1`
(exit before online), `CKX_WEDGE_AFTER_MS` (spin the event loop), `CKX_ALLOC_MB` (grow RSS). Real
Orchestrator, real fork, real IPC:

- heartbeat crosses real IPC → `worker:health` arrives in primary
- RSS recycle → old worker drained gracefully, replacement online, breaker untouched
- wedged worker → `worker:wedged` → drained → replacement online
- quarantine → boot-failing worker reforked exactly N times then stopped, healthy workers keep serving
- `SIGKILL` half the fleet → `fleet:degraded`, then `fleet:recovered` with a positive `degradedDurationMs`

Runs in CI on ubuntu **and** macOS (fork/IPC/kill are portable — nothing depends on reuseport), and
again in the Linux Docker harness. Flakiness discipline: assert ordering and invariants, never
millisecond-exact timings; all timing-exact logic stays in Layer 1 fake timers.

### Layer 3 — E2E (Linux Docker harness, real container, chaos-driven)

Fixture app + scenarios executed by the Linux compose test job (gated via env flag, same pattern as
the Linux-only reuseport assertion):

- boot fixture app with heartbeat + `maxRssMb` + `wedgedTimeoutMs` + `bootFailQuarantine` + prometheus plugin
- **kill chaos**: SIGKILL half workers → assert via HTTP polling + `/metrics`: capacity restored < 15 s, primary alive, gauges present
- **wedge chaos** and **boot-loop chaos** (fixture boot-fails a deterministic fraction of forks so healthy workers coexist)
- **recovery benchmark** (§4.6) doubles as the performance e2e

Platform matrix: Layer 1 + 2 run everywhere; Layer 3 runs in the Linux Docker harness only
(`describe.skipIf` / env-gated, reason documented inline).

### Cross-layer guarantees

- Coverage floors in `vitest.config.ts` for new modules: `health-monitor` lines ≥ 95 / branches ≥ 85
  (coordinator level); existing floors maintained.
- Every user-facing behavior asserted at **two** layers minimum (unit decision + integration
  reality); perf claims only at layer 3.
- Existing suite (305 tests) stays green untouched — no behavior change to existing paths.

## 7. Task breakdown

| # | Task | Files |
|---|---|---|
| 1 | Config/types/validation for health options | `types.ts`, `validation.ts`, `index.ts`, tests |
| 2 | HealthMonitor module + heartbeat + IPC routing | `src/health-monitor.ts`, `worker-manager.ts`, `orchestrator.ts`, tests |
| 3 | Fleet health + degraded/recovered hysteresis | `orchestrator.ts`, `types.ts`, `index.ts`, tests |
| 4 | RSS recycling policy | `health-monitor.ts`, `worker-manager.ts`, `orchestrator.ts`, tests |
| 5 | Wedged-kill policy | `health-monitor.ts`, tests (fake timers) |
| 6 | Boot-loop quarantine | `restart-coordinator.ts`, `orchestrator.ts`, coordinator tests |
| 7 | Prometheus plugin: health gauges/counters | `plugin-prometheus/src`, tests |
| 8 | compileCache option | `plugin-container-sizing/src`, tests, README |
| 9 | Recovery benchmark scenario + baseline | `benchmarks/` (runner lifecycle mode), results committed |
| 10 | E2E chaos suite + docs/changesets sweep | `test/e2e/`, `docker/`, README, AGENTS.md, changesets |

Sequence: 1 → 2 → 3 → 4+5 → 6 → 7 → 8 → 9 → 10. Each task ships module + mirror tests + README +
changeset.

## 8. Risks

- **Wedged false positives** under event-loop starvation: first-report precondition + generous
  defaults + docs (choose `wedgedTimeoutMs` ≫ expected worst-case loop stall). Residual risk bounded
  by the drain ladder (a starved worker dies as a normal recycle).
- **RSS vs cgroup OOM gap**: docs must set `maxRssMb` well below pod limit (primary + native
  overhead headroom); Linux recipe ≈ 70% × (cgroup memory − primary overhead) / workers.
- **Quarantine reduces capacity permanently** until the user acts: surfaced via `getFleetHealth()`
  and events by design; `restartWorkers()` is the documented remedy.
- **Benchmark variance**: recovery numbers are committed as reference (3 runs, median) with the
  harness's existing methodology caveats (AUDIT-029).

## 9. Measurability contract

### 9.1 Product metrics (prometheus plugin)

| Metric | Type | Labels | Source |
|---|---|---|---|
| `clusterkit_worker_rss_bytes` | gauge | `workerId` | `worker:health` |
| `clusterkit_worker_heap_used_bytes` | gauge | `workerId` | `worker:health` |
| `clusterkit_worker_eventloop_lag_ms` | gauge | `workerId` | `worker:health` |
| `clusterkit_worker_heartbeat_age_seconds` | gauge | `workerId` | scrape time − last report |
| `clusterkit_fleet_active_workers` / `_target_workers` | gauges | — | fleet events |
| `clusterkit_fleet_quarantined_slots` | gauge | — | `worker:quarantined` / resets |
| `clusterkit_worker_recycles_total` | counter | `reason` | `worker:recycle` |
| `clusterkit_worker_wedged_kills_total` | counter | — | `worker:wedged` |
| `clusterkit_recovery_duration_seconds` | gauge | — | `fleet:recovered.degradedDurationMs` |

### 9.2 Numeric test gates

- Coverage floors per §6.
- Integration: exact assertions (refork count == N, event ordering, breaker count unchanged after
  RSS recycle).
- E2E: capacity restored < 15 s (3 workers), 0 failed in-flight requests during RSS drain,
  `heartbeat_age < 2 × interval` in steady state, gauges present and > 0 on `/metrics`.

### 9.3 Baseline-first protocol

1. Recovery bench on clean `main` → "before" numbers committed.
2. Each feature lands → re-run → delta table (restore time, boot time per replacement, requests
   served during the degraded window).
3. A/B built into the harness: `--compile-cache on/off`, features on/off.
4. `NODE_COMPILE_CACHE` ships only if the boot delta is demonstrably positive (explicit kill
   criterion).

### 9.4 Definition of Done per task

Tests green + coverage floor met + corresponding e2e scenario green + (if applicable) metric exposed
and asserted in e2e + README documenting the metric and its recommended threshold.
