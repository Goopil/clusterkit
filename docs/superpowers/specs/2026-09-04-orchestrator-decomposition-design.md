# Orchestrator decomposition — design

**Date:** 2026-09-04
**Status:** Approved (conversation)
**Scope:** `packages/worker-manager` — internal refactor, zero behavior change, public API untouched.

## Problem

`src/orchestrator.ts` is 1283 lines and mixes several responsibilities beyond its facade role.
`WorkerManager`, `ShutdownCoordinator`, and `CrashTracker` were already extracted; the two largest
remaining blocks are the crash-restart machinery (~350 lines: restart queue, backoff, fork-failure
accounting, breaker reactions) and the drain/recycle flow (~110 lines + bounded exit wait used by
hot restart).

## Decision (surgical, per discussion)

Two new coordinators; the Orchestrator stays the public facade (~650 lines after extraction).

### `RestartCoordinator` (`src/restart-coordinator.ts`, ~280 lines)

Owns *when and how a crashed/missing worker is restarted*. Moves from the Orchestrator:

- State: `pendingRestartQueue`, `restartLoopRunning`, `restartBackoffDelay`, `backoffResetTimer`,
  `consecutiveForkFailures`, `breakerWarningEmitted`, `RestartQueueEntry`,
  `MAX_CONSECUTIVE_FORK_FAILURES`.
- Behavior: crash path of `handleWorkerExit` (breaker trip reaction, queueing, kick),
  backoff scheduling/cancel (`handleWorkerOnline` / non-graceful exit), restart loop,
  fork-failure accounting (shared with the `restartWorkers()` roll via
  `noteForkFailure/noteForkSuccess/isForkEnvUnrecoverable`), `requestCapacityRefill`,
  `reset()` (tracker + backoff + fork-failure counter).

Deps injected in constructor: `forkWorker`, `isShuttingDown`, `targetWorkerCount`,
`recyclingCount`, `onRestarted` (emits `worker:restart`), `onBreakerTripped`
(flips `health.ready` and emits `circuit-breaker:tripped`).

**Exit-code protocol split:** failure codes (`process.exitCode = 1`) are written by the
coordinator (empty fleet, breaker trip, fork give-up); recovery codes (`process.exitCode = 0`,
`health.ready = true`) stay in the Orchestrator (`handleWorkerOnline`, `resetCircuitBreaker`).

### `DrainCoordinator` (`src/drain-coordinator.ts`, ~200 lines)

Owns *making a replaced worker exit, bounded*. Moves: the recycle drain race (replacement
online/exit + failsafe), `drainRecycledWorker` (IPC shutdown → disconnect → SIGTERM → SIGKILL),
`awaitBoundedWorkerExit`, the `workerDrainBudgetMs` budget. Shared by age-based recycling
(through a thin `Orchestrator.handleWorkerRecycle` that keeps the `worker:recycle` event
emission) and by `restartWorkers()`. The `worker:recycle` event emission stays in the Orchestrator.

### What stays in the Orchestrator

Public API, plugin lifecycle, primary/single-worker/worker startup, `shutdownPrimary`,
`handleWorkerExit` (event emissions + graceful path + delegation), exit-code recovery writes,
signal registry, `safeEmit`, worker-count resolution.

## Test migration

Following the repo convention (`test/<module>.test.ts` mirrors `src/<module>.ts`):

- `test/restart-coordinator.test.ts` — new unit tests against the coordinator (fake fork,
  fake predicates): queue FIFO, backoff growth, fork-failure give-up, breaker reactions,
  reset/refill.
- `test/drain-coordinator.test.ts` — unit tests against the coordinator with shared
  `test/helpers` MockWorker: escalation budget, shutdown guards, failsafe, bounded exit.
- `orchestrator.test.ts` keeps: event-emission wiring tests, `restartWorkers()` block
  (incl. EPIPE drain race), `circuit breaker` + `exit code protocol` blocks (public API).

## Non-goals

- No behavior change: events, metrics, timings, logs semantics, public API unchanged.
- New services get their own logger prefix (`clusterkit:restart-coordinator`,
  `clusterkit:drain-coordinator`) — the established per-service pattern.
- No dedup of `drainRecycledWorker` with `ShutdownCoordinator.killWorkerGradually`
  (different sequencing: timer-armed vs await-based; unification would change behavior).
- No new runtime dependencies.

## Risks

- Private-state pokes in `orchestrator.test.ts` (`restartWorkerWithBackoff` spy,
  `pendingRestartQueue`, `processRestartQueue`, `restartLoopRunning`) are re-pointed at the
  coordinator in the extraction commits, then replaced by dedicated unit tests.
- Per-file coverage floors in `vitest.config.ts` need entries for the two new files.
