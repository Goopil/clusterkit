# Orchestrator decomposition — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the crash-restart machinery and the drain/recycle flow out of `orchestrator.ts` (1283 lines) into two focused services, with zero behavior change and mirror test files.

**Architecture:** `RestartCoordinator` (restart queue, backoff, fork-failure accounting, breaker reactions) and `DrainCoordinator` (bounded drain of replaced workers) become internal services wired by the Orchestrator, which remains the public facade. Spec: `docs/superpowers/specs/2026-09-04-orchestrator-decomposition-design.md`.

**Tech Stack:** TypeScript, Node.js `node:cluster`, vitest (fake timers via `vi.useFakeTimers`), tsdown/turborepo, biome.

## Global Constraints

- Load nvm before ANY command: `source ~/.nvm/nvm.sh && nvm use` (reads `.nvmrc`, Node ≥ 22.12).
- Package manager: `corepack pnpm`, never bare `pnpm`.
- Zero behavior change: events, metrics, exit codes, timings unchanged. Public API untouched (`src/index.ts` unmodified).
- No new runtime dependencies. All code and comments in English.
- The Orchestrator keeps every public member; only internals move.
- Logger prefixes follow the per-service pattern: `clusterkit:restart-coordinator`, `clusterkit:drain-coordinator`.
- Tests live in `packages/worker-manager/test/`, vitest globals enabled (no import needed for `describe/it/expect`).
- Every commit must leave the suite green: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit test`.

---

### Task 1: Extract `RestartCoordinator`

**Files:**
- Create: `packages/worker-manager/src/restart-coordinator.ts`
- Modify: `packages/worker-manager/src/orchestrator.ts`
- Modify: `packages/worker-manager/test/orchestrator.test.ts` (re-point 3 private-state pokes)

**Interfaces:**
- Consumes: `CrashTracker` (existing), `ResolvedConfig`, `WorkerMetrics`, `Logger`, `Worker` from `node:cluster`.
- Produces: `RestartCoordinator`, `RestartCoordinatorDeps`, `RestartQueueEntry`, `MAX_CONSECUTIVE_FORK_FAILURES` (all exported from `src/restart-coordinator.ts`). Public methods: `onWorkerCrash(workerId: number, code: number | null, signal: string | null): void`, `onWorkerOnline(workerId: number): void`, `cancelBackoffReset(): void`, `reset(): void`, `requestCapacityRefill(count: number): void`, `noteForkFailure(): number`, `noteForkSuccess(): void`, `isForkEnvUnrecoverable(): boolean`.

- [ ] **Step 1: Create `src/restart-coordinator.ts`**

```ts
import type { Worker } from "node:cluster";
import { CrashTracker } from "./crash-tracker";
import type { Logger, ResolvedConfig, WorkerMetrics } from "./types";

/**
 * Consecutive fork failures (EMFILE/ENOMEM...) tolerated before the restart
 * machinery declares the environment unrecoverable and stops retrying.
 */
export const MAX_CONSECUTIVE_FORK_FAILURES = 3;

/**
 * A pending restart: either the restart of a crashed worker, or a capacity
 * refill queued after resetCircuitBreaker() (no worker actually crashed).
 */
export type RestartQueueEntry =
  | { kind: "refill" }
  | { kind: "crash"; workerId: number; code: number | null; signal: string | null };

/** Dependencies injected by the Orchestrator. */
export interface RestartCoordinatorDeps {
  /** Fork a replacement worker (WorkerManager.forkWorker). */
  forkWorker: () => Worker;
  /** True while a graceful shutdown is in progress. */
  isShuttingDown: () => boolean;
  /** Resolved worker count target. */
  targetWorkerCount: () => number;
  /** Workers marked for recycling — still alive but already replaced. */
  recyclingCount: () => number;
  /** Called after a replacement was forked (Orchestrator emits worker:restart). */
  onRestarted: (newWorker: Worker) => void;
  /** Called when the breaker trips (Orchestrator flips readiness and emits circuit-breaker:tripped). */
  onBreakerTripped: (info: { crashCount: number; windowMs: number }) => void;
}

/**
 * Owns the crash-restart machinery: restart queue, exponential backoff,
 * fork-failure accounting, and circuit-breaker reactions.
 *
 * Failure protocol (process.exitCode = 1): written here on an empty fleet, a
 * breaker trip, or an unrecoverable fork environment. Recovery (exitCode = 0,
 * health.ready = true) is owned by the Orchestrator.
 */
export class RestartCoordinator {
  private readonly cfg: ResolvedConfig;
  private readonly log: Logger | null;
  private readonly metrics: WorkerMetrics;
  private readonly crashTracker: CrashTracker;
  private readonly deps: RestartCoordinatorDeps;

  // Restart queue state
  private restartLoopRunning = false;
  private pendingRestartQueue: RestartQueueEntry[] = [];

  // Exponential backoff for worker restarts
  private restartBackoffDelay = 0;
  private backoffResetTimer?: NodeJS.Timeout;

  // Consecutive forkWorker() failures — reset on any successful fork
  private consecutiveForkFailures = 0;

  // One process warning per breaker trip
  private breakerWarningEmitted = false;

  constructor(
    cfg: ResolvedConfig,
    log: Logger | null,
    metrics: WorkerMetrics,
    crashTracker: CrashTracker,
    deps: RestartCoordinatorDeps,
  ) {
    this.cfg = cfg;
    this.log = log;
    this.metrics = metrics;
    this.crashTracker = crashTracker;
    this.deps = deps;
  }

  /**
   * A worker crashed (unclean exit): record the crash, react to a possible
   * breaker trip, otherwise queue a restart and kick the loop.
   */
  onWorkerCrash(workerId: number, code: number | null, signal: string | null): void {
    // ALWAYS record, even if restart is locked
    this.crashTracker.record();

    // An empty fleet cannot recover on its own once the event loop drains
    // (all restart/backoff timers are unref'd): flag a failure exit code so
    // supervisors do not read the death of the primary as a clean stop.
    // Cleared when capacity is restored (Orchestrator.handleWorkerOnline).
    if (this.metrics.activeWorkers === 0) {
      process.exitCode = 1;
    }

    if (this.crashTracker.isTripped()) {
      this.log?.error("Crash loop detected — stopping restarts", {
        crashCount: this.crashTracker.count,
        windowMs: this.cfg.restart.crashWindowMs,
      });
      // A tripped breaker self-terminates the primary once the fleet drains,
      // and exit 0 would mask the crash. Cleared by resetCircuitBreaker() or
      // restored capacity (Orchestrator.handleWorkerOnline).
      process.exitCode = 1;
      // The default logger is null: without this, a minimal setup loses
      // restart capacity with zero output. One warning per trip.
      if (!this.breakerWarningEmitted) {
        this.breakerWarningEmitted = true;
        process.emitWarning(
          "Crash loop detected — stopping worker restarts. Fix the cause, then call resetCircuitBreaker() to re-arm.",
          "ClusterKitCrashLoop",
        );
      }
      this.metrics.crashLoopBackoffs++;
      this.deps.onBreakerTripped({ crashCount: this.crashTracker.count, windowMs: this.cfg.restart.crashWindowMs });
      return;
    }

    // Breaker no longer tripped (reset or window slid) — a future trip warns again
    this.breakerWarningEmitted = false;

    // Queue restart and process asynchronously
    this.pendingRestartQueue.push({ kind: "crash", workerId, code, signal });
    this.kickRestartQueue();
  }

  /** A replacement came online: reset backoff after a sustained crash-free window. */
  onWorkerOnline(workerId: number): void {
    // Reset backoff only after a sustained crash-free window
    if (this.restartBackoffDelay > 0) {
      this.scheduleBackoffReset(workerId);
    }
  }

  /** A non-graceful exit breaks stability and cancels a pending backoff reset. */
  cancelBackoffReset(): void {
    clearTimeout(this.backoffResetTimer);
    this.backoffResetTimer = undefined;
  }

  /** Reset engine state (tracker, backoff, fork-failure counter). */
  reset(): void {
    this.crashTracker.reset();
    this.restartBackoffDelay = 0;
    this.consecutiveForkFailures = 0;
  }

  /**
   * Queue `count` capacity refills (after the Orchestrator accepted a breaker
   * reset and knows the fleet had already forked).
   */
  requestCapacityRefill(count: number): void {
    for (let i = 0; i < count; i++) {
      this.pendingRestartQueue.push({ kind: "refill" });
    }
    if (count > 0) {
      this.kickRestartQueue();
    }
  }

  /** Record a fork failure (EMFILE/ENOMEM...). Returns the consecutive failure count. */
  noteForkFailure(): number {
    return ++this.consecutiveForkFailures;
  }

  /** Record a successful fork: resets the consecutive failure counter. */
  noteForkSuccess(): void {
    this.consecutiveForkFailures = 0;
  }

  /** True once the fork environment is declared unrecoverable. */
  isForkEnvUnrecoverable(): boolean {
    return this.consecutiveForkFailures >= MAX_CONSECUTIVE_FORK_FAILURES;
  }

  private scheduleBackoffReset(workerId: number): void {
    if (this.cfg.restart.stabilityWindowMs === 0) {
      this.restartBackoffDelay = 0;
      this.log?.info("Worker start successful, reset restart backoff", {
        workerId,
        stabilityWindowMs: 0,
      });
      return;
    }

    clearTimeout(this.backoffResetTimer);

    this.backoffResetTimer = setTimeout(() => {
      this.backoffResetTimer = undefined;

      if (this.deps.isShuttingDown() || this.restartBackoffDelay === 0) {
        return;
      }

      this.restartBackoffDelay = 0;
      this.log?.info("Cluster remained stable, reset restart backoff", {
        stabilityWindowMs: this.cfg.restart.stabilityWindowMs,
      });
    }, this.cfg.restart.stabilityWindowMs).unref();
  }

  private kickRestartQueue(): void {
    this.processRestartQueue().catch((err) => {
      this.log?.error("Restart queue processing failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async processRestartQueue(): Promise<void> {
    if (this.restartLoopRunning) return;
    this.restartLoopRunning = true;

    try {
      while (this.pendingRestartQueue.length > 0) {
        if (this.deps.isShuttingDown()) {
          this.pendingRestartQueue = [];
          return;
        }

        // A tripped breaker stops all forks: queued entries are dropped —
        // resetCircuitBreaker() refills the missing capacity after the reset.
        if (this.crashTracker.isTripped()) {
          this.pendingRestartQueue = [];
          return;
        }

        const entry = this.pendingRestartQueue.shift();
        if (!entry) return;

        // Workers being recycled are still alive but already have a replacement
        // (or are about to exit) — exclude them so a crash overlapping a recycle
        // is not silently dropped, leaving the cluster under capacity.
        const targetWorkers = this.deps.targetWorkerCount();
        const settledWorkers = this.metrics.activeWorkers - this.deps.recyclingCount();
        const missingWorkers = Math.max(0, targetWorkers - settledWorkers);
        if (missingWorkers === 0) {
          continue;
        }

        await this.restartWorkerWithBackoff(entry);
      }
    } finally {
      this.restartLoopRunning = false;

      if (this.pendingRestartQueue.length > 0 && !this.deps.isShuttingDown()) {
        this.kickRestartQueue();
      }
    }
  }

  private async restartWorkerWithBackoff(entry: RestartQueueEntry): Promise<void> {
    const crashedWorkerId = entry.kind === "crash" ? entry.workerId : undefined;

    const delayMs = this.restartBackoffDelay > 0 ? this.restartBackoffDelay : this.cfg.restart.backoffMs;

    if (delayMs > 0) {
      this.log?.info("Waiting before restart", { delayMs, workerId: crashedWorkerId });
      await new Promise((resolve) => setTimeout(resolve, delayMs).unref());

      // Double check shutdown hasn't started during wait
      if (this.deps.isShuttingDown()) {
        this.log?.info("Shutdown started during backoff, aborting restart", { workerId: crashedWorkerId });
        return;
      }
    }

    // Fork-time breaker check: a trip between queueing and forking must not
    // leak a fork past the breaker. resetCircuitBreaker() refills the missing
    // capacity after the operator reset.
    if (this.crashTracker.isTripped()) {
      return;
    }

    if (entry.kind === "crash") {
      this.log?.warn("Worker crashed, restarting", {
        workerId: entry.workerId,
        code: entry.code,
        signal: entry.signal,
      });
    } else {
      this.log?.info("Refilling capacity after circuit breaker reset");
    }

    let newWorker: Worker;
    try {
      newWorker = this.deps.forkWorker();
    } catch (err) {
      // A fork failure (EMFILE/ENOMEM...) must not permanently shrink the
      // fleet: re-queue the entry so it is retried through the normal backoff.
      this.consecutiveForkFailures++;
      this.log?.error("Worker fork failed — restart re-queued", {
        attempt: this.consecutiveForkFailures,
        maxAttempts: MAX_CONSECUTIVE_FORK_FAILURES,
        error: err instanceof Error ? err.message : String(err),
      });
      if (this.consecutiveForkFailures >= MAX_CONSECUTIVE_FORK_FAILURES) {
        // Unrecoverable fork environment: flag a failure exit code (same
        // protocol as a breaker trip) and stop retrying.
        this.log?.error("Fork failing repeatedly — giving up on pending restarts", {
          maxAttempts: MAX_CONSECUTIVE_FORK_FAILURES,
        });
        process.exitCode = 1;
        this.pendingRestartQueue.length = 0;
        return;
      }
      this.pendingRestartQueue.push(entry);
      return;
    }
    this.consecutiveForkFailures = 0;

    this.metrics.workerRestarts++;
    this.deps.onRestarted(newWorker);

    // Increase backoff for next restart
    // First restart: use initial delay, others: multiply by factor
    const nextDelay = delayMs > 0 ? delayMs * this.cfg.restart.backoffMultiplier : this.cfg.restart.backoffMs;
    this.restartBackoffDelay = Math.min(nextDelay, this.cfg.restart.maxBackoffMs);
  }
}
```

- [ ] **Step 2: Rewire `src/orchestrator.ts`**

Edits, in order (line numbers refer to the pre-change file):

1. Imports — add:
```ts
import { MAX_CONSECUTIVE_FORK_FAILURES, RestartCoordinator } from "./restart-coordinator";
```
2. Delete the module-level `MAX_CONSECUTIVE_FORK_FAILURES` const and `RestartQueueEntry` type (lines 24-36).
3. Delete fields (lines 85, 92-93, 96-99): `breakerWarningEmitted`, `restartLoopRunning`, `pendingRestartQueue`, `restartBackoffDelay`, `consecutiveForkFailures`. KEEP `crashTracker` and `crashCleanupInterval`. Add field next to the other services:
```ts
  private readonly restartCoordinator: RestartCoordinator;
```
4. Constructor — after the `shutdownCoordinator.setupCallbacks(...)` block (line 142), add:
```ts
    this.restartCoordinator = new RestartCoordinator(
      this.cfg,
      withLoggerPrefix(this.baseLog, "clusterkit:restart-coordinator"),
      this.metrics,
      this.crashTracker,
      {
        forkWorker: () => this.workerManager.forkWorker(),
        isShuttingDown: () => this.shutdownCoordinator.isShutdownInProgress(),
        targetWorkerCount: () => this.resolveWorkerCount(),
        recyclingCount: () => this.workerManager.getRecyclingCount(),
        onRestarted: (worker) =>
          this.safeEmit("worker:restart", { newWorkerId: worker.id, newPid: worker.process.pid ?? 0 }),
        onBreakerTripped: (info) => {
          // A tripped breaker means the cluster can no longer maintain capacity:
          // flip readiness so load balancers / probes stop routing traffic here.
          this.health.ready = false;
          this.safeEmit("circuit-breaker:tripped", info);
        },
      },
    );
```
5. `resetCircuitBreaker()` — replace the body between `resetCircuitBreaker(): this {` (line 338) and `return this;` with:
```ts
    this.restartCoordinator.reset();

    if (!this.shutdownCoordinator.isShutdownInProgress()) {
      this.health.ready = true;

      // The operator declared the underlying cause fixed: clear the failure
      // exit code flagged when the breaker tripped or the fleet emptied
      // (see handleWorkerExit).
      process.exitCode = 0;

      // Refill any capacity lost while the breaker was tripped
      if (this.hasForked) {
        const missing = Math.max(0, this.resolveWorkerCount() - this.metrics.activeWorkers);
        this.restartCoordinator.requestCapacityRefill(missing);
      }
    }

    this.log?.info("Circuit breaker reset");
```
6. `handleWorkerOnline()` (line 699) — replace the whole method with:
```ts
  private handleWorkerOnline(worker: Worker): void {
    this.restartCoordinator.onWorkerOnline(worker.id);

    // Fleet back at target capacity: a failure exit code flagged while the
    // fleet was down (see handleWorkerExit) is resolved.
    if (this.metrics.activeWorkers >= this.resolveWorkerCount()) {
      process.exitCode = 0;
    }

    this.safeEmit("worker:online", { workerId: worker.id, pid: worker.process.pid ?? 0 });
  }
```
7. In `handleWorkerExit()` (line 745): replace `this.clearBackoffResetTimer();` with `this.restartCoordinator.cancelBackoffReset();`, and replace everything from the `// Crash - record for circuit breaker (ALWAYS record, even if restart is locked)` comment (line 775) through `this.kickRestartQueue();` (line 826) with:
```ts
    // Crash - record for circuit breaker and decide restart/breaker fate
    this.safeEmit("worker:crash", {
      workerId: worker.id,
      pid: worker.process.pid ?? 0,
      code,
      signal,
    });
    this.restartCoordinator.onWorkerCrash(worker.id, code, signal);
```
(The empty-fleet `process.exitCode = 1` write and the whole `isTripped()` branch now live in the coordinator.)
8. Delete methods `scheduleBackoffReset`, `clearBackoffResetTimer`, `kickRestartQueue`, `processRestartQueue`, `restartWorkerWithBackoff` (lines 714-946, minus what step 7 already removed).
9. In `shutdownPrimary()` — replace `this.clearBackoffResetTimer();` (line 1071) with `this.restartCoordinator.cancelBackoffReset();`.
10. In `restartWorkers()` — replace the fork-failure catch and the success reset (lines 457-474):
```ts
        } catch (err) {
          // A fork failure (EMFILE/ENOMEM...) leaves the old worker running
          // (still serving) — better than an unhandled exception killing the
          // primary. The worker is NOT marked for recycling.
          const attempt = this.restartCoordinator.noteForkFailure();
          this.log?.error("Hot restart fork failed — old worker left running", {
            workerId: oldWorker.id,
            attempt,
            maxAttempts: MAX_CONSECUTIVE_FORK_FAILURES,
            error: err instanceof Error ? err.message : String(err),
          });
          if (this.restartCoordinator.isForkEnvUnrecoverable()) {
            forkFailureBailout = true;
            break;
          }
          continue;
        }
        this.restartCoordinator.noteForkSuccess();
```

- [ ] **Step 3: Re-point the 3 private-state pokes in `test/orchestrator.test.ts`**

Add to the imports:
```ts
import type { RestartCoordinator, RestartQueueEntry } from "../src/restart-coordinator";
```

Poke A — test "processes the restart queue in FIFO order (first crash restarted first)" (~line 900), replace the spy target:
```ts
      const restartSpy = vi.spyOn(
        (orch as unknown as { restartCoordinator: RestartCoordinator }).restartCoordinator as unknown as {
          restartWorkerWithBackoff: (entry: RestartQueueEntry) => Promise<void>;
        },
        "restartWorkerWithBackoff",
      );
```
Poke B — test "should skip stale queued restarts…" (~line 1090), replace both casts:
```ts
        const coordinator = (orch as unknown as { restartCoordinator: RestartCoordinator }).restartCoordinator;
        (
          coordinator as unknown as { pendingRestartQueue: RestartQueueEntry[] }
        ).pendingRestartQueue.push({ kind: "crash", workerId: 999, code: 1, signal: null });

        await (coordinator as unknown as { processRestartQueue: () => Promise<void> }).processRestartQueue();
```
Poke C — assertion in "should not fork a replacement when shutdown starts during crash backoff" (~line 1143):
```ts
      expect(
        (orch as unknown as { restartCoordinator: { restartLoopRunning: boolean } }).restartCoordinator
          .restartLoopRunning,
      ).toBe(true);
```

- [ ] **Step 4: Run the suite**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit exec vitest run test/orchestrator.test.ts`
Expected: PASS (same test count as before the change).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm build && corepack pnpm lint`

```bash
git add packages/worker-manager/src/restart-coordinator.ts packages/worker-manager/src/orchestrator.ts packages/worker-manager/test/orchestrator.test.ts
git commit -m "ref(core): extract RestartCoordinator from Orchestrator"
```

---

### Task 2: Extract `DrainCoordinator`

**Files:**
- Create: `packages/worker-manager/src/drain-coordinator.ts`
- Modify: `packages/worker-manager/src/orchestrator.ts`

**Interfaces:**
- Consumes: `ResolvedConfig`, `WorkerMetrics`, `Logger`, `Worker`.
- Produces: `DrainCoordinator`, `DrainCoordinatorDeps`. Public methods: `recycle(oldWorker: Worker, newWorker: Worker): void`, `awaitBoundedWorkerExit(worker: Worker): Promise<void>`.

- [ ] **Step 1: Create `src/drain-coordinator.ts`**

Move the bodies verbatim from the Orchestrator, comments included. The file:

```ts
import type { Worker } from "node:cluster";
import type { Logger, ResolvedConfig, WorkerMetrics } from "./types";

/** Dependencies injected by the Orchestrator. */
export interface DrainCoordinatorDeps {
  isShuttingDown: () => boolean;
}

/**
 * Drains replaced workers in a bounded way: notify via IPC, disconnect, then
 * escalate SIGTERM → SIGKILL if the worker does not exit on its own.
 * Used by age-based recycling (via Orchestrator.handleWorkerRecycle) and by
 * hot restarts (restartWorkers → awaitBoundedWorkerExit).
 */
export class DrainCoordinator {
  private readonly cfg: ResolvedConfig;
  private readonly log: Logger | null;
  private readonly metrics: WorkerMetrics;
  private readonly isShuttingDown: () => boolean;
  private readonly shutdownType: string;

  constructor(cfg: ResolvedConfig, log: Logger | null, metrics: WorkerMetrics, deps: DrainCoordinatorDeps) {
    this.cfg = cfg;
    this.log = log;
    this.metrics = metrics;
    this.isShuttingDown = deps.isShuttingDown;
    this.shutdownType = `${cfg.shutdown.messagePrefix}:shutdown`;
  }

  /**
   * Budget for a recycled/replaced worker to exit on its own: the full
   * shutdown escalation window (graceful timeout + signal delays) plus a
   * margin, after which it is force-killed.
   */
  private get workerDrainBudgetMs(): number {
    return this.cfg.shutdown.timeoutMs + this.cfg.shutdown.sigtermDelayMs + this.cfg.shutdown.sigintDelayMs + 5_000;
  }

  /**
   * Drain orchestration for a replaced worker: watch the replacement's
   * "online" (drain the old worker) and "exit" (replacement died at boot —
   * drain anyway) events, with a bounded failsafe for a replacement that
   * never reaches either.
   */
  recycle(oldWorker: Worker, newWorker: Worker): void {
    // If the replacement dies before coming online (OOM at boot, invalid
    // flag...), the online handler below never runs and the old worker would
    // linger undrained — drain it instead so the recycle still completes.
    let replacementOnline = false;
    let drained = false;
    const drainOldWorker = (): void => {
      if (drained) return;
      drained = true;
      clearTimeout(drainFailsafeTimer);
      this.drainRecycledWorker(oldWorker);
    };

    newWorker.once("exit", () => {
      if (drained || replacementOnline || this.isShuttingDown()) return;
      this.log?.warn("Replacement died before online, draining old worker", { workerId: oldWorker.id });
      drainOldWorker();
    });

    // Disconnect old worker after new one is online
    newWorker.once("online", () => {
      replacementOnline = true;
      if (this.isShuttingDown()) return;
      drainOldWorker();
    });

    // Failsafe: the drain trigger fires only on the replacement's "online" or
    // "exit" event — a replacement that is forked but stuck before "online"
    // (boot hang) and never exits would leave the old worker undrained
    // forever. Drain it anyway once the same bounded budget as
    // awaitBoundedWorkerExit expires.
    const drainFailsafeTimer = setTimeout(() => {
      if (replacementOnline || this.isShuttingDown() || oldWorker.isDead()) return;
      this.log?.warn("Replacement did not come online in time, draining old worker anyway", {
        workerId: oldWorker.id,
        newWorkerId: newWorker.id,
      });
      drainOldWorker();
    }, this.workerDrainBudgetMs);
    drainFailsafeTimer.unref();
  }

  /**
   * Wait for a recycled worker to exit during a hot restart, with a bounded
   * wait: if the worker outlives the total shutdown budget (graceful timeout
   * + signal delays) plus a margin, force-kill it so the rolling restart
   * cannot deadlock on an "exit" event that never arrives (e.g. replacement
   * never came online and the drain escalation in `recycle` never armed).
   *
   * Implemented with an explicit setTimeout race instead of
   * `once(worker, "exit", { signal: AbortSignal.timeout(ms) })` because
   * AbortSignal.timeout is backed by native timers that never fire under
   * vitest fake timers.
   */
  async awaitBoundedWorkerExit(worker: Worker): Promise<void> {
    // The worker may have died between the snapshot and this call: its "exit"
    // event already fired, so waiting for it would stall for the full budget.
    if (worker.isDead()) return;

    const exitWaitMs = this.workerDrainBudgetMs;

    await new Promise<void>((resolve) => {
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;

      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(waitTimer);
        if (graceTimer) clearTimeout(graceTimer);
        worker.removeListener("exit", onExit);
        worker.removeListener("exit", onGracePeriodExit);
        resolve();
      };

      const onExit = () => settle();
      const onGracePeriodExit = () => settle();

      const waitTimer = setTimeout(() => {
        this.log?.warn("Old worker did not exit in time during restart, forcing kill", {
          workerId: worker.id,
          pid: worker.process.pid ?? 0,
        });
        try {
          if (!worker.isDead()) {
            worker.process.kill("SIGKILL");
            this.metrics.forcedKills++;
          }
        } catch {
          /* already dead */
        }
        // Best-effort: give the force-killed worker a short grace period to
        // emit "exit" before moving on to the next worker in the roll.
        graceTimer = setTimeout(settle, 2_000);
        graceTimer.unref();
        worker.once("exit", onGracePeriodExit);
      }, exitWaitMs);
      waitTimer.unref();

      worker.once("exit", onExit);
    });
  }

  /**
   * Drain a recycled worker: request shutdown, disconnect, then escalate to
   * SIGTERM and SIGKILL if the worker does not exit on its own.
   */
  private drainRecycledWorker(oldWorker: Worker): void {
    // A worker can exit concurrently with the drain: its IPC write then fails
    // with 'write EPIPE'/'channel closed', which Node surfaces as an ASYNC
    // 'error' event on worker.process (child_process._send) — after the sync
    // try/catch below has passed, and fatal to the primary without a
    // listener. Route send errors to a no-op callback (Worker.send delegates
    // to process.send, which routes send errors to a callback when given)
    // and keep a no-op 'error' listener on the process for the worker's
    // remaining lifetime: disconnect()'s internal send accepts no callback,
    // so its failure can only be absorbed by the listener (same pattern as
    // ShutdownCoordinator.initiateShutdown).
    const swallowError = (): void => {};
    oldWorker.process.on("error", swallowError);

    try {
      oldWorker.send({ type: this.shutdownType }, swallowError);
      if (!oldWorker.isDead()) oldWorker.disconnect();
    } catch {
      /* worker already dead */
    }

    if (oldWorker.isDead()) return;

    // Escalate on the same budget as a coordinated shutdown: the worker keeps
    // its full graceful window (shutdown.timeoutMs) before SIGTERM, then the
    // same SIGTERM→SIGINT→SIGKILL escalation window (sigtermDelayMs +
    // sigintDelayMs) before SIGKILL — matching what
    // ShutdownCoordinator.killWorkerGradually would spend on it.
    // Calling disconnect() again is a no-op on an already-disconnected
    // worker, so we must escalate to signals to prevent a stuck worker
    // from leaking.
    //
    // The sigkillTimer's exit listener is registered inside the
    // forceKillTimer callback — so if the worker exits after SIGTERM
    // (before the SIGKILL window), the timer is cleared. Both
    // listeners use once(), so no listener accumulation across recycles.
    const forceKillTimer = setTimeout(() => {
      if (!oldWorker.isDead() && !this.isShuttingDown()) {
        try {
          oldWorker.process.kill("SIGTERM");
        } catch {
          /* already dead */
        }
        const sigkillTimer = setTimeout(() => {
          if (!oldWorker.isDead() && !this.isShuttingDown()) {
            try {
              oldWorker.process.kill("SIGKILL");
              this.metrics.forcedKills++;
            } catch {
              /* already dead */
            }
          }
        }, this.cfg.shutdown.sigtermDelayMs + this.cfg.shutdown.sigintDelayMs);
        sigkillTimer.unref();
        oldWorker.once("exit", () => clearTimeout(sigkillTimer));
      }
    }, this.cfg.shutdown.timeoutMs);
    forceKillTimer.unref();
    oldWorker.once("exit", () => clearTimeout(forceKillTimer));
  }
}
```

- [ ] **Step 2: Rewire `src/orchestrator.ts`**

1. Import + field:
```ts
import { DrainCoordinator } from "./drain-coordinator";
```
```ts
  private readonly drainCoordinator: DrainCoordinator;
```
2. Constructor — after the `restartCoordinator` block:
```ts
    this.drainCoordinator = new DrainCoordinator(
      this.cfg,
      withLoggerPrefix(this.baseLog, "clusterkit:drain-coordinator"),
      this.metrics,
      { isShuttingDown: () => this.shutdownCoordinator.isShutdownInProgress() },
    );
```
3. `handleWorkerRecycle()` (line 948) — keep the event emission, delegate the rest:
```ts
  private handleWorkerRecycle(oldWorker: Worker, newWorker: Worker): void {
    const ageMs = this.workerManager.getWorkerAge(oldWorker.id);
    this.safeEmit("worker:recycle", {
      workerId: oldWorker.id,
      pid: oldWorker.process.pid ?? 0,
      ageMs,
    });
    this.drainCoordinator.recycle(oldWorker, newWorker);
  }
```
4. Delete: the old `handleWorkerRecycle` body (replacement race + failsafe), `drainRecycledWorker` (lines 1001-1060), `awaitBoundedWorkerExit` (lines 523-570), the `workerDrainBudgetMs` getter (lines 1210-1212).
5. In `restartWorkers()`: replace `await this.awaitBoundedWorkerExit(oldWorker);` (line 482) with `await this.drainCoordinator.awaitBoundedWorkerExit(oldWorker);`.

- [ ] **Step 3: Run the suite**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit test`
Expected: PASS.

- [ ] **Step 4: Typecheck, lint, commit**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm build && corepack pnpm lint`

```bash
git add packages/worker-manager/src/drain-coordinator.ts packages/worker-manager/src/orchestrator.ts
git commit -m "ref(core): extract DrainCoordinator from Orchestrator"
```

---

### Task 3: Create `test/restart-coordinator.test.ts`, trim `orchestrator.test.ts`

**Files:**
- Create: `packages/worker-manager/test/restart-coordinator.test.ts`
- Modify: `packages/worker-manager/test/orchestrator.test.ts` (delete migrated tests)
- Modify: `packages/worker-manager/vitest.config.ts` (coverage floor)

**Interfaces:**
- Consumes: `RestartCoordinator`, `MAX_CONSECUTIVE_FORK_FAILURES`, `RestartQueueEntry` from Task 1; `CrashTracker`; shared `MockWorker` from `./helpers`.

**Migration table — DELETE these tests from `orchestrator.test.ts`** (superseded by the new unit tests; match by name, not line number):

| Test (in "worker crash and restart") | New unit test in restart-coordinator.test.ts |
|---|---|
| "should restart all crashed workers when crashes overlap" | "restarts every queued crash until capacity is met" |
| "processes the restart queue in FIFO order (first crash restarted first)" | "processes the restart queue in FIFO order (first crash restarted first)" |
| "should not double-increment restart backoff after a crash" | "restarts the first crash after backoffMs and the next after backoffMs * multiplier" |
| "should keep elevated backoff while stability window is not reached" | covered by the backoff test above (same assertion core) |
| "should keep elevated backoff when another worker stays healthy during partial flapping" | "does not reset backoff when the fleet is not stable during the window" |
| "should reset backoff after the stability window elapses" | "resets backoff after the stability window elapses" |
| "resets restart backoff immediately when stabilityWindowMs is 0" | "resets restart backoff immediately when stabilityWindowMs is 0" |
| "should skip stale queued restarts when workers is auto and capacity is already met" | "skips stale queued restarts when capacity is already met" |
| "should not fork a replacement when shutdown starts during crash backoff" | "does not fork a replacement when shutdown starts during backoff" |
| "should unref the crash-restart backoff timer" | "unrefs the crash-restart backoff timer" |
| "fork failure resilience" (3 tests, lines 1241-1332) | the three tests in the "fork failure resilience" describe below |

**KEEP in `orchestrator.test.ts`** (Orchestrator wiring/emissions): "should restart a crashed worker", "should emit worker:crash on unclean exit", "should emit worker:restart after crash", "should increment workerRestarts metric", "should not duplicate workerExecArgv across restarts", "should not restart a gracefully disconnected worker", "should emit worker:exit on graceful worker shutdown", plus the `circuit breaker` and `exit code protocol` blocks and the whole `restartWorkers()` block.

- [ ] **Step 1: Write the new test file**

Create `test/restart-coordinator.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Worker } from "node:cluster";
import { CrashTracker } from "../src/crash-tracker";
import { MAX_CONSECUTIVE_FORK_FAILURES, RestartCoordinator } from "../src/restart-coordinator";
import type { RestartQueueEntry } from "../src/restart-coordinator";
import type { ResolvedConfig, WorkerMetrics } from "../src/types";
import { MockWorker } from "./helpers";

const config: ResolvedConfig = {
  logger: null,
  workers: { count: 2, env: undefined, execArgv: undefined, maxAgeMs: 0 },
  restart: {
    crashThreshold: 5,
    crashWindowMs: 60_000,
    backoffMs: 0,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2,
    stabilityWindowMs: 0,
  },
  shutdown: {
    timeoutMs: 1_000,
    ackTimeoutMs: 500,
    messagePrefix: "__rc",
    sigtermDelayMs: 100,
    sigintDelayMs: 100,
  },
  clusterModule: undefined,
};

function makeMetrics(): WorkerMetrics {
  return { workerRestarts: 0, activeWorkers: 0, crashLoopBackoffs: 0, gracefulShutdowns: 0, forcedKills: 0 };
}

interface Harness {
  coordinator: RestartCoordinator;
  metrics: WorkerMetrics;
  crashTracker: CrashTracker;
  fork: ReturnType<typeof vi.fn>;
  restarts: MockWorker[];
  breakerTrips: Array<{ crashCount: number; windowMs: number }>;
  isShuttingDown: ReturnType<typeof vi.fn>;
  nextWorkerId: { value: number };
}

/**
 * Mirrors the real wiring: WorkerManager.forkWorker() increments
 * activeWorkers at fork time and decrements it on worker exit, so the
 * harness does the same around the coordinator calls.
 */
function makeCoordinator(
  overrides: {
    restart?: Partial<ResolvedConfig["restart"]>;
    target?: number;
    recycling?: number;
    forkImpl?: () => MockWorker;
  } = {},
): Harness {
  const metrics = makeMetrics();
  const nextWorkerId = { value: 1 };
  const crashTracker = new CrashTracker(
    overrides.restart?.crashThreshold ?? config.restart.crashThreshold,
    overrides.restart?.crashWindowMs ?? config.restart.crashWindowMs,
  );
  const restarts: MockWorker[] = [];
  const breakerTrips: Array<{ crashCount: number; windowMs: number }> = [];
  const isShuttingDown = vi.fn(() => false);
  const fork = vi.fn(
    overrides.forkImpl ??
      (() => {
        metrics.activeWorkers++;
        return new MockWorker(nextWorkerId.value++);
      }),
  );
  const coordinator = new RestartCoordinator(
    { ...config, restart: { ...config.restart, ...(overrides.restart ?? {}) } },
    null,
    metrics,
    crashTracker,
    {
      forkWorker: fork as unknown as () => Worker,
      isShuttingDown,
      targetWorkerCount: vi.fn(() => overrides.target ?? 2),
      recyclingCount: vi.fn(() => overrides.recycling ?? 0),
      onRestarted: (w) => restarts.push(w as MockWorker),
      onBreakerTripped: (info) => breakerTrips.push(info),
    },
  );
  return { coordinator, metrics, crashTracker, fork, restarts, breakerTrips, isShuttingDown, nextWorkerId };
}

/** Simulate an unclean crash: WorkerManager already removed the worker. */
function crash(h: Harness, workerId: number): void {
  h.metrics.activeWorkers = Math.max(0, h.metrics.activeWorkers - 1);
  h.coordinator.onWorkerCrash(workerId, 1, null);
}

let savedExitCode: typeof process.exitCode;

beforeEach(() => {
  savedExitCode = process.exitCode;
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
});

describe("RestartCoordinator", () => {
  describe("crash → restart", () => {
    it("restarts a crashed worker by forking a replacement", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator();
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.fork).toHaveBeenCalledTimes(1);
      expect(h.metrics.workerRestarts).toBe(1);
      expect(h.restarts).toHaveLength(1);
    });

    it("restarts every queued crash until capacity is met", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ target: 3 });
      h.metrics.activeWorkers = 3;

      crash(h, 1);
      crash(h, 2);
      crash(h, 3);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.metrics.workerRestarts).toBe(3);
      expect(h.restarts).toHaveLength(3);
    });

    it("processes the restart queue in FIFO order (first crash restarted first)", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ target: 3 });
      h.metrics.activeWorkers = 3;

      // swapping shift() → pop() (FIFO → LIFO) passed CI historically —
      // restart order was never asserted by workerId. The spy below keeps
      // that regression covered at the unit level.
      const spy = vi.spyOn(
        h.coordinator as unknown as {
          restartWorkerWithBackoff: (entry: RestartQueueEntry) => Promise<void>;
        },
        "restartWorkerWithBackoff",
      );

      crash(h, 1);
      crash(h, 2);
      crash(h, 3);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.metrics.workerRestarts).toBe(3);
      expect(spy.mock.calls.map((call) => (call[0] as { workerId: number }).workerId)).toEqual([1, 2, 3]);
    });

    it("skips stale queued restarts when capacity is already met", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ target: 2 });
      h.metrics.activeWorkers = 2;

      // A stale entry (worker id no longer maps to missing capacity): the
      // queue loop must drop it without forking.
      (h.coordinator as unknown as { pendingRestartQueue: RestartQueueEntry[] }).pendingRestartQueue.push({
        kind: "crash",
        workerId: 999,
        code: 1,
        signal: null,
      });

      await (h.coordinator as unknown as { processRestartQueue: () => Promise<void> }).processRestartQueue();

      expect(h.fork).not.toHaveBeenCalled();
      expect(h.metrics.workerRestarts).toBe(0);
    });

    it("accounts for workers being recycled in the capacity math", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ target: 2, recycling: 1 });
      // active 3 = 2 healthy + 1 recycling-but-alive: the crash below must
      // still be restarted even though activeWorkers >= target.
      h.metrics.activeWorkers = 3;

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.metrics.workerRestarts).toBe(1);
    });
  });

  describe("backoff", () => {
    it("restarts the first crash after backoffMs and the next after backoffMs * multiplier", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 1_000, backoffMultiplier: 2 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(999);
      expect(h.fork).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.fork).toHaveBeenCalledTimes(1);

      crash(h, 3);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(h.fork).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.fork).toHaveBeenCalledTimes(2);
    });

    it("does not fork a replacement when shutdown starts during backoff", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 1_000 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      h.isShuttingDown.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(h.fork).not.toHaveBeenCalled();
      expect(h.metrics.workerRestarts).toBe(0);
    });

    it("resets backoff after the stability window elapses", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 1_000, backoffMultiplier: 4, stabilityWindowMs: 5_000 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(1_000); // first restart (backoff → 4s)
      const restarted = h.restarts[0];

      // Replacement comes online → schedules the backoff reset
      h.coordinator.onWorkerOnline(restarted.id);
      await vi.advanceTimersByTimeAsync(5_000); // stability window elapses → backoff → 0

      crash(h, restarted.id);
      await vi.advanceTimersByTimeAsync(1_000); // base backoff again, not 4s
      expect(h.fork).toHaveBeenCalledTimes(2);
    });

    it("resets restart backoff immediately when stabilityWindowMs is 0", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 1_000, backoffMultiplier: 4, stabilityWindowMs: 0 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(1_000);
      const restarted = h.restarts[0];

      h.coordinator.onWorkerOnline(restarted.id);

      crash(h, restarted.id);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.fork).toHaveBeenCalledTimes(2);
    });

    it("unrefs the crash-restart backoff timer", () => {
      const unrefSpy = vi.fn();
      const nativeSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        handler: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        const timer = nativeSetTimeout(handler, delay, ...args) as NodeJS.Timeout;
        const originalUnref = timer.unref.bind(timer);
        timer.unref = () => {
          unrefSpy();
          return originalUnref();
        };
        return timer;
      }) as typeof setTimeout);

      const h = makeCoordinator({ restart: { backoffMs: 5_000 } });
      h.metrics.activeWorkers = 2;

      // Crash one worker: the restart loop schedules (and must unref) the
      // 5s backoff timer synchronously within the spied window.
      crash(h, 1);

      const backoffCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5_000);
      expect(backoffCallIndex).toBeGreaterThanOrEqual(0);
      expect(unrefSpy).toHaveBeenCalledTimes(1);

      // Do not let the pending backoff timer outlive the test.
      clearTimeout(setTimeoutSpy.mock.results[backoffCallIndex].value as NodeJS.Timeout);
      vi.restoreAllMocks();
    });
  });

  describe("fork failure resilience", () => {
    it("re-queues a restart when fork throws and restores capacity on the retry", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 100 } });
      h.metrics.activeWorkers = 2;
      h.fork.mockImplementationOnce(() => {
        throw new Error("Resource temporarily unavailable");
      });

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(100); // first attempt fails
      expect(h.fork).toHaveBeenCalledTimes(1);
      expect(h.metrics.workerRestarts).toBe(0);

      await vi.advanceTimersByTimeAsync(100); // re-queued entry retried
      expect(h.fork).toHaveBeenCalledTimes(2);
      expect(h.metrics.workerRestarts).toBe(1);
    });

    it(`gives up after ${MAX_CONSECUTIVE_FORK_FAILURES} consecutive fork failures and flags exit code 1`, async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { backoffMs: 0 } });
      h.metrics.activeWorkers = 2;
      h.fork.mockImplementation(() => {
        throw new Error("Resource temporarily unavailable");
      });

      crash(h, 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(process.exitCode).toBe(1);
      // Queue cleared: no further fork attempts
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.fork).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FORK_FAILURES);
    });

    it("refill entries log a capacity refill instead of a fake crash report", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ target: 2 });
      h.metrics.activeWorkers = 1;

      h.coordinator.requestCapacityRefill(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.metrics.workerRestarts).toBe(1);
      expect(h.restarts).toHaveLength(1);
    });
  });

  describe("circuit breaker reactions", () => {
    it("trips, warns once, counts backoffs and signals onBreakerTripped", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { crashThreshold: 2, crashWindowMs: 60_000 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1); // below threshold: a replacement is forked
      await vi.advanceTimersByTimeAsync(0);
      expect(h.metrics.workerRestarts).toBe(1);

      crash(h, 3); // trips the breaker
      await vi.advanceTimersByTimeAsync(1_000);

      expect(h.breakerTrips).toEqual([{ crashCount: 2, windowMs: 60_000 }]);
      expect(h.metrics.crashLoopBackoffs).toBe(1);
      expect(process.emitWarning).toHaveBeenCalledTimes(1);
      expect(process.emitWarning).toHaveBeenCalledWith(expect.stringContaining("Crash loop"), "ClusterKitCrashLoop");
      expect(h.fork).toHaveBeenCalledTimes(1); // no fork past the trip
    });

    it("drops queued restarts once the breaker has tripped", async () => {
      vi.useFakeTimers();
      const h = makeCoordinator({ restart: { crashThreshold: 2, backoffMs: 100 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1); // queued, backoff pending
      crash(h, 3); // trips the breaker
      await vi.advanceTimersByTimeAsync(1_000);

      expect(h.fork).not.toHaveBeenCalled();
      expect(h.metrics.workerRestarts).toBe(0);
    });

    it("warns again if the breaker trips a second time after a reset", () => {
      const h = makeCoordinator({ restart: { crashThreshold: 2 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      crash(h, 3);
      expect(process.emitWarning).toHaveBeenCalledTimes(1);

      h.coordinator.reset();
      crash(h, 5);
      crash(h, 7);
      expect(process.emitWarning).toHaveBeenCalledTimes(2);
    });
  });

  describe("shared fork-failure counter (hot restart roll)", () => {
    it("notes failures/successes and flags an unrecoverable env at the limit", () => {
      const h = makeCoordinator();

      expect(h.coordinator.noteForkFailure()).toBe(1);
      expect(h.coordinator.isForkEnvUnrecoverable()).toBe(false);
      expect(h.coordinator.noteForkFailure()).toBe(2);
      expect(h.coordinator.noteForkFailure()).toBe(3);
      expect(h.coordinator.isForkEnvUnrecoverable()).toBe(true);

      h.coordinator.noteForkSuccess();
      expect(h.coordinator.isForkEnvUnrecoverable()).toBe(false);
    });

    it("reset() clears the tracker, backoff and fork-failure counter", () => {
      const h = makeCoordinator({ restart: { crashThreshold: 2 } });
      h.metrics.activeWorkers = 2;

      crash(h, 1);
      crash(h, 3);
      expect(h.crashTracker.isTripped()).toBe(true);

      h.coordinator.reset();
      expect(h.crashTracker.isTripped()).toBe(false);
      expect(h.coordinator.isForkEnvUnrecoverable()).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit exec vitest run test/restart-coordinator.test.ts`
Expected: PASS. If a fake-timer assertion is off by a tick, nudge `advanceTimersByTimeAsync` by ±2ms (the originals use the same technique).

- [ ] **Step 3: Trim `orchestrator.test.ts`**

Delete the tests listed in the migration table (match by name). Keep `setupPrimary` — remaining tests use it.

- [ ] **Step 4: Add the coverage floor**

In `packages/worker-manager/vitest.config.ts`, inside `thresholds`, add (value = measured − 2; run `corepack pnpm --filter @goopil/clusterkit exec vitest run --coverage` and adjust to the measured numbers):

```ts
        "src/restart-coordinator.ts": { lines: 95, branches: 85 },
```

- [ ] **Step 5: Run the package suite with coverage**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit exec vitest run --coverage`
Expected: PASS, all floors met. If `src/orchestrator.ts` measured coverage moved, retune its floor (currently `{ lines: 93, branches: 76 }`).

- [ ] **Step 6: Commit**

```bash
git add packages/worker-manager/test/restart-coordinator.test.ts packages/worker-manager/test/orchestrator.test.ts packages/worker-manager/vitest.config.ts
git commit -m "test(core): unit tests for RestartCoordinator, trim orchestrator suite"
```

---

### Task 4: Create `test/drain-coordinator.test.ts`, trim `orchestrator.test.ts`

**Files:**
- Create: `packages/worker-manager/test/drain-coordinator.test.ts`
- Modify: `packages/worker-manager/test/orchestrator.test.ts`
- Modify: `packages/worker-manager/vitest.config.ts` (coverage floor)

**Interfaces:**
- Consumes: `DrainCoordinator` from Task 2; shared `MockWorker` (`deadOnDisconnect: false` keeps a worker stuck).

**Migration table — DELETE these tests from `orchestrator.test.ts`** (they drive the drain via the age-recycle sweep through the orchestrator: `maxAgeMs`, 60s interval, 30s stagger; the new unit tests call `drainer.recycle(old, new)` directly and keep the same assertions):

| Test (in "worker recycle SIGKILL escalation") | New unit test in drain-coordinator.test.ts |
|---|---|
| "escalates drain kills relative to the configured shutdown budget" | "escalates SIGTERM at shutdown.timeoutMs then SIGKILL after sigtermDelayMs + sigintDelayMs" |
| "does not SIGTERM a stuck recycled worker once shutdown has started" | same name |
| "does not SIGKILL a recycled worker once shutdown has started after SIGTERM" | same name |
| "drains the old worker when the replacement never comes online" | same name |

**KEEP in `orchestrator.test.ts`:** the `worker recycling` block (worker:recycle event emission — Orchestrator wiring) and the whole `restartWorkers()` block including "recycled worker IPC EPIPE (drain race)" and "fork failure resilience (roll)".

- [ ] **Step 1: Write the new test file**

Create `test/drain-coordinator.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrainCoordinator } from "../src/drain-coordinator";
import type { ResolvedConfig, WorkerMetrics } from "../src/types";
import { MockWorker } from "./helpers";

const config: ResolvedConfig = {
  logger: null,
  workers: { count: 2, env: undefined, execArgv: undefined, maxAgeMs: 0 },
  restart: {
    crashThreshold: 5,
    crashWindowMs: 60_000,
    backoffMs: 0,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2,
    stabilityWindowMs: 0,
  },
  shutdown: {
    timeoutMs: 1_000,
    ackTimeoutMs: 500,
    messagePrefix: "__dc",
    sigtermDelayMs: 300,
    sigintDelayMs: 200,
  },
  clusterModule: undefined,
};

function makeMetrics(): WorkerMetrics {
  return { workerRestarts: 0, activeWorkers: 0, crashLoopBackoffs: 0, gracefulShutdowns: 0, forcedKills: 0 };
}

function makeDrainer(overrides: { isShuttingDown?: () => boolean } = {}) {
  const metrics = makeMetrics();
  const drainer = new DrainCoordinator({ ...config }, null, metrics, {
    isShuttingDown: overrides.isShuttingDown ?? (() => false),
  });
  return { drainer, metrics };
}

/** Old worker that survives disconnect so the escalation path is exercised. */
function stuckWorker(id: number): MockWorker {
  return new MockWorker(id, { deadOnDisconnect: false });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-12T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DrainCoordinator", () => {
  it("sends the shutdown message and disconnects the old worker once the replacement is online", () => {
    const { drainer } = makeDrainer();
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2);

    drainer.recycle(oldWorker, newWorker);
    newWorker.emit("online");

    expect(oldWorker.send).toHaveBeenCalledWith({ type: "__dc:shutdown" }, expect.any(Function));
    expect(oldWorker.disconnect).toHaveBeenCalledTimes(1);
  });

  it("drains the old worker when the replacement dies before coming online", () => {
    const { drainer } = makeDrainer();
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2, { deadOnDisconnect: false });

    drainer.recycle(oldWorker, newWorker);
    newWorker.emit("exit", 1, null);

    expect(oldWorker.disconnect).toHaveBeenCalledTimes(1);
  });

  it("escalates SIGTERM at shutdown.timeoutMs then SIGKILL after sigtermDelayMs + sigintDelayMs", async () => {
    const { metrics, drainer } = makeDrainer();
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2);

    drainer.recycle(oldWorker, newWorker);
    newWorker.emit("online"); // arms the drain
    await vi.advanceTimersByTimeAsync(0);

    // SIGTERM at shutdown.timeoutMs (1s here)
    await vi.advanceTimersByTimeAsync(999);
    expect(oldWorker.process.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(oldWorker.process.kill).toHaveBeenCalledWith("SIGTERM");

    // SIGKILL after sigtermDelayMs + sigintDelayMs more (500ms here)
    await vi.advanceTimersByTimeAsync(498);
    expect(oldWorker.process.kill).not.toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(2);
    expect(oldWorker.process.kill).toHaveBeenCalledWith("SIGKILL");
    expect(metrics.forcedKills).toBe(1);
  });

  it("does not SIGTERM a stuck recycled worker once shutdown has started", async () => {
    let shuttingDown = false;
    const { metrics, drainer } = makeDrainer({ isShuttingDown: () => shuttingDown });
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2);

    drainer.recycle(oldWorker, newWorker);
    newWorker.emit("online"); // drain arms before the test starts the shutdown
    await vi.advanceTimersByTimeAsync(0);
    expect(oldWorker.isConnected()).toBe(false); // drained (shutdown message + disconnect)
    expect(oldWorker.isDead()).toBe(false); // stuck

    // Shutdown starts BEFORE the SIGTERM escalation (timeoutMs) fires
    shuttingDown = true;
    await vi.advanceTimersByTimeAsync(1_002);
    expect(oldWorker.process.kill).not.toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(501);
    expect(oldWorker.process.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(metrics.forcedKills).toBe(0);
  });

  it("does not SIGKILL once shutdown has started after SIGTERM", async () => {
    let shuttingDown = false;
    const { metrics, drainer } = makeDrainer({ isShuttingDown: () => shuttingDown });
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2);

    drainer.recycle(oldWorker, newWorker);
    newWorker.emit("online");
    await vi.advanceTimersByTimeAsync(0);

    // SIGTERM fires before shutdown: escalation fully armed, SIGKILL pending
    await vi.advanceTimersByTimeAsync(1_002);
    expect(oldWorker.process.kill).toHaveBeenCalledWith("SIGTERM");

    // Shutdown starts in the SIGKILL window (sigtermDelayMs + sigintDelayMs)
    shuttingDown = true;
    await vi.advanceTimersByTimeAsync(502);
    expect(oldWorker.process.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(metrics.forcedKills).toBe(0);
  });

  it("drains the old worker when the replacement never comes online (failsafe)", async () => {
    const { drainer } = makeDrainer();
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2, { deadOnDisconnect: false }); // never online, never exits

    drainer.recycle(oldWorker, newWorker);

    // Failsafe budget = timeoutMs + sigtermDelayMs + sigintDelayMs + 5s = 6.5s
    await vi.advanceTimersByTimeAsync(6_499);
    expect(oldWorker.isConnected()).toBe(true);

    await vi.advanceTimersByTimeAsync(2);
    expect(oldWorker.isConnected()).toBe(false); // drained
    expect(oldWorker.disconnect).toHaveBeenCalledTimes(1); // exactly once — no double drain
  });

  it("skips the failsafe when shutdown is in progress", async () => {
    const { drainer } = makeDrainer({ isShuttingDown: () => true });
    const oldWorker = stuckWorker(1);
    const newWorker = new MockWorker(2, { deadOnDisconnect: false });

    drainer.recycle(oldWorker, newWorker);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(oldWorker.isConnected()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit exec vitest run test/drain-coordinator.test.ts`
Expected: PASS. If the `send` assertion mismatches, check the exact call in `drainRecycledWorker`: `oldWorker.send({ type: this.shutdownType }, swallowError)` — assert `{ type: "__dc:shutdown" }` plus the callback arg.

- [ ] **Step 3: Trim `orchestrator.test.ts`**

Delete the four tests in the migration table (match by name). Keep the `worker recycling` block and everything in `restartWorkers()`.

- [ ] **Step 4: Add the coverage floor + run coverage**

In `vitest.config.ts` thresholds add (value = measured − 2):

```ts
        "src/drain-coordinator.ts": { lines: 95, branches: 85 },
```

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit exec vitest run --coverage`
Expected: PASS, all floors met.

- [ ] **Step 5: Commit**

```bash
git add packages/worker-manager/test/drain-coordinator.test.ts packages/worker-manager/test/orchestrator.test.ts packages/worker-manager/vitest.config.ts
git commit -m "test(core): unit tests for DrainCoordinator, trim orchestrator suite"
```

---

### Task 5: Docs, changeset, full validation

**Files:**
- Modify: `AGENTS.md` (architecture notes)
- Create: `.changeset/<generated>.md`

- [ ] **Step 1: Update `AGENTS.md`**

In "Architecture notes → Core package", after the `crash-tracker.ts` line, add:

```markdown
- `restart-coordinator.ts` — `RestartCoordinator`: crash-restart machinery (restart queue,
  exponential backoff, fork-failure accounting, breaker reactions). Owns failure exit codes;
  the Orchestrator owns recovery (`exitCode = 0`, `health.ready = true`).
- `drain-coordinator.ts` — bounded drain of replaced workers (IPC shutdown → disconnect →
  SIGTERM → SIGKILL), shared by age-based recycling and hot restarts.
```

- [ ] **Step 2: Add the changeset**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm changeset`
Select `@goopil/clusterkit`, bump **patch**, message:

```
refactor: split Orchestrator internals into RestartCoordinator and DrainCoordinator services. No public API change.
```

- [ ] **Step 3: Full CI-equivalent validation (in order)**

```bash
source ~/.nvm/nvm.sh && nvm use
corepack pnpm lint          # biome check .
corepack pnpm build         # turbo build (type declarations)
corepack pnpm test          # all packages
corepack pnpm test:packages # packaging smoke
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md .changeset
git commit -m "docs: register extracted coordinators in AGENTS.md, add changeset"
```

---

## Validation checklist (whole plan)

- `git log --oneline` shows 5 focused commits, each green.
- `corepack pnpm --filter @goopil/clusterkit exec vitest run --coverage` passes all per-file floors.
- `git diff main -- packages/worker-manager/src/index.ts` is empty (no public API change).
- Behavior invariants spot-check: same events, same exit-code protocol, same escalation budgets, same restart-queue semantics.
