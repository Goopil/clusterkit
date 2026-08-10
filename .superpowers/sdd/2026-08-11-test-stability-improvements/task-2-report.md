# Task 2 Report: Expand shutdown-coordinator tests

## What I implemented

Overwrote `packages/worker-manager/test/shutdown-coordinator.test.ts` with comprehensive test coverage for `ShutdownCoordinator`. The test suite now covers 9 scenarios:

1. **Happy path** — worker ACKs, gets disconnected, callbacks fire
2. **Idempotency** — second `initiateShutdown` call is a no-op
3. **ACK timeout** — worker doesn't ACK within `ackTimeoutMs`, gets disconnected with warn log
4. **Worker already dead** — coordinator skips sending shutdown message
5. **Worker already disconnected** — coordinator skips sending, escalates to kill to force exit
6. **worker.send() throws** — coordinator catches error, disconnects, and resolves
7. **SIGTERM → SIGINT → SIGKILL escalation** — stubborn worker refuses to die, all three signals are sent in order with proper delays
8. **Multiple workers (mixed)** — one ACKs, one times out, one already dead
9. **Worker exits before ACK** — ACK wait resolves early on terminal event

Uses the shared `MockWorker` helper from `test/helpers/mock-worker.ts` and a local `StubbornWorker` class for the escalation test (never ACKs, only dies on SIGKILL).

## What I tested and test results

```
corepack pnpm --filter @goopil/clusterkit exec vitest run test/shutdown-coordinator.test.ts

Test Files  1 passed (1)
Tests      9 passed (9)
Duration  121ms
```

All 9 tests pass with no warnings. Lint passes (biome auto-fixed import ordering and indentation).

## Files changed

- `packages/worker-manager/test/shutdown-coordinator.test.ts` — full overwrite (183 insertions, 27 deletions)

## Adaptations from the brief

Two tests required adjustments from the brief's original code:

1. **"resolves immediately when worker is already disconnected"** — The brief expected the coordinator to resolve immediately, but a disconnected-but-not-dead worker causes `waitForWorkersToExit` to wait for the timeout, then `killWorkerGradually` escalates SIGTERM→SIGINT→SIGKILL to force the worker to die. Added `await vi.advanceTimersByTimeAsync(1200)` to advance through the exit timeout and kill delays.

2. **"escalates from SIGTERM to SIGINT to SIGKILL"** — Two timing adjustments:
   - Changed `advanceTimersByTimeAsync(600)` to `advanceTimersByTimeAsync(500)` for the ACK timeout to avoid overshooting into the kill delay.
   - Moved the SIGTERM assertion before advancing `sigtermDelayMs` — `killWorkerGradually` sends SIGTERM immediately, then waits the delay before SIGINT. The brief's original code advanced 100ms before asserting SIGTERM, which actually triggered the SIGINT.

## Self-review findings

- All 9 tests pass with pristine output (no warnings, no timeouts)
- Tests verify real behavior: signal escalation order, ACK timeout disconnect, idempotency, dead worker skipping
- Lint clean after auto-fix (import ordering, indentation)
- Follows existing patterns: uses shared `MockWorker` helper, fake timers, `baseConfig`/`makeMetrics` fixtures
- No public API changes; test-only change

## Issues or concerns

None. The two timing adjustments from the brief are documented above and reflect the actual behavior of `ShutdownCoordinator`.

## Review Fix Report

Fixed two review findings:

1. **Misleading test name** (Important): Renamed "resolves immediately when worker is already disconnected" → "skips sending shutdown message when worker is already disconnected" at line 137. The test advances 1200ms and kills via SIGKILL escalation, so it verifies the send-skip, not immediate resolution.
2. **Unawaited `advanceTimersByTimeAsync`** (Minor): Added `await` to `vi.advanceTimersByTimeAsync(500)` at line 116 so microtask flushing completes.

### Test results after fix

```
corepack pnpm --filter @goopil/clusterkit exec vitest run test/shutdown-coordinator.test.ts

Test Files  1 passed (1)
Tests      9 passed (9)
Duration   142ms
```

All 9 tests still pass.
