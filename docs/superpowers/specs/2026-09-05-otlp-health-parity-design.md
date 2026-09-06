# OTLP Meter Plugin — Health, Fleet & Recovery Metrics Parity

Date: 2026-09-05
Status: approved (design dialogue with repo owner)
Scope: `packages/plugin-otlp-meter` only

## Problem

PR #166 added the worker health & recovery subsystem to the core and wired it into
`plugin-prometheus` (per-worker health gauges, recycle/wedged counters, live fleet gauges,
recovery duration). The `plugin-otlp-meter` plugin still exposes only the pre-#166 surface
(`active_workers`, `worker.restarts`, `worker.crashes`, `circuit_breaker.trips`, optional
host-metrics), so OTel-based users cannot observe what Prometheus users can. The repo owner
requested parity of exposed values.

## Goal

Expose the same metric set as `plugin-prometheus` from `plugin-otlp-meter`, translated to
OpenTelemetry idioms (observable gauges, attribute-keyed series, dot-separated names per the
plugin's existing convention). No core changes, no new dependencies.

## Non-goals

- No shared "health registry" module between plugins (~30 lines of duplicated map/event logic
  is not worth cross-package coupling).
- No worker-side changes: health heartbeats already reach the primary via core IPC; the plugin
  only binds primary-side listeners.
- No new public options: metrics appear unconditionally (they emit data only when the events
  they track fire — e.g. no health heartbeats when health monitoring is disabled in core, the
  default).

## Metric inventory (1:1 with plugin-prometheus)

| OTLP name (`prefix` + name) | Prometheus counterpart | Instrument | Attributes |
|---|---|---|---|
| `clusterkit.worker.rss_bytes` | `worker_rss_bytes` | observable gauge | `worker.id`, `process.pid` |
| `clusterkit.worker.heap_used_bytes` | `worker_heap_used_bytes` | observable gauge | `worker.id`, `process.pid` |
| `clusterkit.worker.eventloop_lag_ms` | `worker_eventloop_lag_ms` | observable gauge | `worker.id`, `process.pid` |
| `clusterkit.worker.heartbeat_age_seconds` | `worker_heartbeat_age_seconds` | observable gauge | `worker.id`, `process.pid` |
| `clusterkit.active_workers` (existing, unchanged) | `active_workers` | observable gauge | — |
| `clusterkit.fleet.active_workers` (new) | `fleet_active_workers` | observable gauge | — |
| `clusterkit.fleet.target_workers` | `fleet_target_workers` | observable gauge | — |
| `clusterkit.fleet.quarantined_slots` | `fleet_quarantined_slots` | observable gauge | — |
| `clusterkit.worker.recycles` | `worker_recycles_total` | counter | `reason` (rss / maxAge / wedged — core `RecycleReason`) |
| `clusterkit.worker.wedged.kills` | `worker_wedged_kills_total` | counter | — |
| `clusterkit.recovery.duration_seconds` | `recovery_duration_seconds` | gauge (set on event) | — |

Notes:

- `worker.id` and `process.pid` attribute values come from the event payload (`workerId`, `pid`).
- `heartbeat_age_seconds` is computed at export time (now − last heartbeat timestamp) by the
  observable callback, mirroring prometheus scrape-time computation.
- `recovery.duration_seconds` is a synchronous gauge recorded from the `fleet:recovered`
  payload (`degradedDurationMs` → seconds), not an observable callback.

## Behavior

- **Primary process only.** New primary events bound via the existing `bind()` /
  `clearPrimaryListeners()` mechanism:
  - `worker:health` — update a primary-side map keyed by `workerId` alone (cluster worker IDs are monotonic and never
    reused), storing `pid` as an attribute alongside
    `{ rss, heapUsed, eventLoopLagMs, lastBeatAt }`.
  - `worker:exit` — delete the map entry; the worker's series stops being emitted on the next
    export (same drop semantics as prometheus).
  - `worker:recycle` — increment `worker.recycles` with the event's `reason` attribute.
  - `worker:wedged` — increment `worker.wedged.kills`.
  - `fleet:recovered` — record `recovery.duration_seconds`.
- **Observable gauges read live state at export time** (`PeriodicExportingMetricReader` calls
  callbacks on each interval), so no stale-value problem and no registry cleanup on uninstall —
  the stale-gauge issue #166 had to solve for prom-client does not exist here.
- **Health monitoring disabled (core default):** no `worker:health` events → per-worker gauges
  emit no data points; fleet gauges still report (values 0/1 as appropriate). Identical to
  prometheus behavior.
- **Single-worker mode:** no forked workers → no heartbeats → no per-worker data points;
  `instrumentation: true` keeps host-metrics for process-level visibility.
- **Fleet gauges** read `orchestrator.getFleetHealth()` in their callbacks
  (`active`/`target`/`quarantined`).

## Lifecycle

- `install()` — as today, plus: register the new instruments (primary branch only), bind the
  new listeners, keep the existing reinstall semantics (previous provider shutdown).
- `uninstall()` — existing `clearPrimaryListeners()` handles the new events (extend the
  `PrimaryEvent` union); clear the health map.
- `shutdown()` — unchanged.

## Testing

- Unit tests (`test/otlp-meter.test.ts`): the mocked exporters currently discard the exported
  payload; extend them to capture the `ResourceMetrics` argument. Tests then call
  `plugin.meterProvider.forceFlush()` and assert on captured data points. Scenarios mirror
  `plugin-prometheus` tests:
  - health heartbeats → per-worker gauges with correct values and attributes;
  - heartbeat age advances with fake timers;
  - `worker:exit` → series no longer emitted after flush;
  - recycles counted per `reason`; wedged kills counted;
  - fleet target/quarantined reflect mutated orchestrator state;
  - `fleet:recovered` → recovery duration recorded (4321 ms → 4.321 s);
  - uninstall clears listeners (no further counter increments) and the health map.
- e2e (`test/otlp-meter.e2e.test.ts`, mock HTTP collector) — unchanged, plus one assertion on a
  health datapoint if trivial to arrange with a `workers: 2` orchestrator.
- Coverage: `packages/plugin-otlp-meter/vitest.config.ts` floors updated if needed (new code
  covered; existing floors stay).

## Docs

- `packages/plugin-otlp-meter/README.md`: add the new metrics to its metric list/table.
- Changeset: `minor` for `@goopil/clusterkit-otlp-meter`.
