# Hot Restart Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `restartWorkers()` public API to the core orchestrator and build two plugins (signal-restart, file-watcher) that trigger hot (rolling) restarts without dropping connections, plus a hot-reload example app.

**Architecture:** The core `Orchestrator` gets a new `restartWorkers()` method that reuses the existing `handleWorkerRecycle` (fork-then-drain) flow. Two plugins call it: `plugin-signal-restart` (SIGHUP → rolling restart, or SIGTERM exit in single-worker mode) and `plugin-file-watcher` (chokidar file/env watching → debounced rolling restart). A new `restart:start`/`restart:complete` event pair gives observability. The watcher also supports a `dryRun` mode.

**Tech Stack:** TypeScript, Node.js cluster API, tsdown (dual ESM+CJS), vitest, chokidar ^4, pnpm workspaces, turborepo, changesets.

## Global Constraints

- Use `corepack pnpm`, not bare `pnpm`.
- Node `>=22.12.0` (switch with `source ~/.nvm/nvm.sh && nvm use` before any command).
- Core package (`@goopil/clusterkit`) stays runtime-dependency-free (dev/peer deps only).
- Build with `corepack pnpm build` before running tests (turbo `test` depends on `^build` + `build`).
- `tsdown.config.ts` is identical across all packages (dual CJS+ESM, `target: "es2022"`, `dts: true`).
- `tsconfig.json` is identical across all packages (strict mode, `moduleResolution: "bundler"`).
- `vitest.config.ts` is identical across all packages (coverage thresholds: lines/functions/statements 85, branches 75; `testTimeout: 10000`).
- Plugin factory naming: `create<Name>Plugin(options)`.
- Plugin interface extends `OrchestratorPlugin`, adds extra public API.
- `install()` signature: `async install(orchestrator, logger, config): Promise<void>`.
- Worker-process guard at top of `install()`: `if (!cluster.isPrimary) return;`.
- Logger: `const log = withLoggerPrefix(logger, "clusterkit:<name>")`.
- Tests live under each package's `test/` directory.
- Changesets required for any package change.
- Keep all source code, comments, tests, and docs in English.
- Run `corepack pnpm lint` (biome) before finishing.

## File Structure

### Core package (`packages/worker-manager/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify | Add `restart:start` and `restart:complete` events to `OrchestratorEvents` |
| `src/worker-manager.ts` | Modify | Add `envOverlay` parameter to `forkWorker()` |
| `src/orchestrator.ts` | Modify | Add `restartInProgress` field, `restartWorkers()` method, `restart:start`/`restart:complete` emission |
| `test/orchestrator.test.ts` | Modify | Add tests for `restartWorkers()` |
| `test/worker-manager.test.ts` | Modify | Add test for `forkWorker(envOverlay)` |
| `README.md` | Modify | Document `restartWorkers()` API, `restart:start`/`restart:complete` events |
| `.changeset/*.md` | Create | Minor changeset for core |

### Plugin: signal-restart (`packages/plugin-signal-restart/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Create | Package metadata, peerDeps, scripts |
| `tsdown.config.ts` | Create | Build config (identical template) |
| `tsconfig.json` | Create | TS config (identical template) |
| `vitest.config.ts` | Create | Test config (identical template) |
| `src/index.ts` | Create | Plugin factory, `SignalRestartPlugin` interface, `SignalRestartOptions` |
| `test/signal-restart.test.ts` | Create | Unit tests (mock orchestrator) |
| `test/signal-restart.integration.test.ts` | Create | Integration tests (real Orchestrator + worker fixture) |
| `README.md` | Create | Plugin documentation |
| `.changeset/*.md` | Create | Initial release changeset |

### Plugin: file-watcher (`packages/plugin-file-watcher/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Create | Package metadata, peerDeps (chokidar), scripts |
| `tsdown.config.ts` | Create | Build config (identical template) |
| `tsconfig.json` | Create | TS config (identical template) |
| `vitest.config.ts` | Create | Test config (identical template) |
| `src/index.ts` | Create | Plugin factory, `FileWatcherPlugin` interface, `FileWatcherOptions`, `parseEnvFile` |
| `src/parse-env.ts` | Create | `parseEnvFile` pure function (exported for testing) |
| `test/file-watcher.test.ts` | Create | Unit tests (parseEnvFile, debounce, env diff, mock orchestrator) |
| `test/file-watcher.integration.test.ts` | Create | Integration tests (real Orchestrator + temp files) |
| `README.md` | Create | Plugin documentation |
| `.changeset/*.md` | Create | Initial release changeset |

### Example: hot-reload (`examples/hot-reload/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Create | Example metadata, deps (core + both plugins + express) |
| `src/index.mjs` | Create | Express app with signal + watcher plugins |

### Root docs

| File | Action | Responsibility |
|------|--------|----------------|
| `README.md` | Modify | Add both plugins to package table, add hot-reload section |
| `AGENTS.md` | Modify | Add two new packages to repository map, add hot restart architecture note |

---

## Task 1: Core — Add `restart:start` and `restart:complete` events to `OrchestratorEvents`

**Files:**
- Modify: `packages/worker-manager/src/types.ts:133-144`

**Interfaces:**
- Produces: `"restart:start"` and `"restart:complete"` event types on `OrchestratorEvents`. Later tasks emit these via `safeEmit`.

- [ ] **Step 1: Add the new event types**

In `packages/worker-manager/src/types.ts`, add two new events to the `OrchestratorEvents` interface (after the `circuit-breaker:tripped` line, before the closing brace):

```ts
  "restart:start": [data: { reason: string; workerIds: number[] }];
  "restart:complete": [data: { restartedWorkerIds: number[]; reason: string }];
```

The full `OrchestratorEvents` interface after the change:

```ts
export interface OrchestratorEvents {
  "worker:online": [data: { workerId: number; pid: number }];
  "worker:exit": [
    data: { workerId: number; pid: number; code: number | null; signal: string | null; graceful: boolean },
  ];
  "worker:crash": [data: { workerId: number; pid: number; code: number | null; signal: string | null }];
  "worker:restart": [data: { newWorkerId: number; newPid: number }];
  "worker:recycle": [data: { workerId: number; pid: number; ageMs: number }];
  "shutdown:start": [data: { signal: string }];
  "shutdown:complete": [data: { metrics: WorkerMetrics }];
  "circuit-breaker:tripped": [data: { crashCount: number; windowMs: number }];
  "restart:start": [data: { reason: string; workerIds: number[] }];
  "restart:complete": [data: { restartedWorkerIds: number[]; reason: string }];
}
```

- [ ] **Step 2: Build to verify types compile**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit build`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/worker-manager/src/types.ts
git commit -m "feat(core): add restart:start and restart:complete events to OrchestratorEvents"
```

---

## Task 2: Core — Add `envOverlay` parameter to `WorkerManager.forkWorker()`

**Files:**
- Modify: `packages/worker-manager/src/worker-manager.ts:72-84`
- Test: `packages/worker-manager/test/worker-manager.test.ts`

**Interfaces:**
- Consumes: `cfg.workers.env` (already present)
- Produces: `forkWorker(envOverlay?: NodeJS.ProcessEnv): Worker` — when `envOverlay` is provided, merges `{ ...this.cfg.workers.env, ...envOverlay }` for this fork only without mutating `cfg.workers.env`.

- [ ] **Step 1: Write the failing test**

In `packages/worker-manager/test/worker-manager.test.ts`, add a test after the existing `forkWorker` env test (around line 46):

```ts
it("merges envOverlay on top of cfg.workers.env for this fork only", () => {
  const cluster = new MockCluster();
  const cfg = {
    workers: { count: 2, env: { BASE: "1", SHARED: "base" } as NodeJS.ProcessEnv, execArgv: undefined, maxAgeMs: 0 },
  } as unknown as ResolvedConfig;
  const wm = new WorkerManager(cluster, cfg, null);

  // Fork with overlay
  wm.forkWorker({ SHARED: "overlay", NEW: "2" });

  // Overlay merged on top of base env
  expect(cluster.fork).toHaveBeenCalledWith({ BASE: "1", SHARED: "overlay", NEW: "2" });

  // Subsequent fork without overlay uses original env (not mutated)
  wm.forkWorker();
  expect(cluster.fork).toHaveBeenLastCalledWith({ BASE: "1", SHARED: "base" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit exec vitest run test/worker-manager.test.ts`
Expected: FAIL — `forkWorker` does not accept arguments.

- [ ] **Step 3: Implement the overload**

In `packages/worker-manager/src/worker-manager.ts`, change the `forkWorker` method (line 72):

```ts
  forkWorker(envOverlay?: NodeJS.ProcessEnv): Worker {
    if (!this.appliedExecArgv && this.cfg.workers.execArgv?.length) {
      this.clusterRef.setupPrimary({
        execArgv: [...this.baseWorkerExecArgv, ...this.cfg.workers.execArgv],
      });
      this.appliedExecArgv = true;
    }

    const env =
      envOverlay !== undefined
        ? { ...this.cfg.workers.env, ...envOverlay }
        : this.cfg.workers.env;
    const worker = this.clusterRef.fork(env);
    this.workerStartTimes.set(worker.id, Date.now());
    this.metrics.activeWorkers++;
    return worker;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit exec vitest run test/worker-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite for the package**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit test`
Expected: All tests pass (212+).

- [ ] **Step 6: Commit**

```bash
git add packages/worker-manager/src/worker-manager.ts packages/worker-manager/test/worker-manager.test.ts
git commit -m "feat(core): add envOverlay parameter to WorkerManager.forkWorker()"
```

---

## Task 3: Core — Add `restartWorkers()` method to `Orchestrator`

**Files:**
- Modify: `packages/worker-manager/src/orchestrator.ts` (add field near line 84, add method after `resetCircuitBreaker` around line 342)
- Test: `packages/worker-manager/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `WorkerManager.forkWorker(envOverlay?)` (from Task 2), `handleWorkerRecycle(oldWorker, newWorker)` (existing, line 618), `shutdownCoordinator.isShutdownInProgress()` (existing), `workerManager.getActiveWorkers()` (existing), `workerManager.markForRecycling(id)` (existing), `safeEmit` (existing)
- Produces: `async restartWorkers(opts?: { env?, filter?, staggerMs?, reason? }): Promise<void>` — public method on `Orchestrator`

- [ ] **Step 1: Add the `restartInProgress` field**

In `packages/worker-manager/src/orchestrator.ts`, add a new private field after line 84 (`private restartBackoffDelay = 0;`):

```ts
  // Hot restart guard — prevents concurrent restartWorkers() calls
  private restartInProgress = false;
```

- [ ] **Step 2: Add the `restartWorkers()` method**

In `packages/worker-manager/src/orchestrator.ts`, add the method after the `registerOnShutdown` method (around line 325, before `overrideWorkerCount`). This is a public method in the "Public API" section:

```ts
  /**
   * Rolling-restart all (or filtered) workers without dropping connections.
   * Forks a replacement for each worker, then drains the old one via the
   * same `handleWorkerRecycle` path used by age-based recycling.
   *
   * Idempotent: no-op if a restart is already in progress or shutdown has
   * started. Returns early in single-worker mode (no cluster to roll).
   */
  async restartWorkers(opts?: {
    env?: NodeJS.ProcessEnv;
    filter?: (workerId: number) => boolean;
    staggerMs?: number;
    reason?: string;
  }): Promise<void> {
    const reason = opts?.reason ?? "manual";

    // Guard: shutdown in progress
    if (this.shutdownCoordinator.isShutdownInProgress()) {
      this.log?.warn("restartWorkers() ignored — shutdown in progress", { reason });
      return;
    }

    // Guard: already restarting
    if (this.restartInProgress) {
      this.log?.warn("restartWorkers() ignored — restart already in progress", { reason });
      return;
    }

    // Guard: single-worker mode — no cluster to roll
    if (this.workerCount === 1) {
      this.log?.warn("restartWorkers() called in single-worker mode — no cluster to roll", { reason });
      return;
    }

    this.restartInProgress = true;

    try {
      const staggerMs = opts?.staggerMs ?? 1_000;
      const workers = this.workerManager.getActiveWorkers();
      const targeted = opts?.filter ? workers.filter((w) => opts.filter!(w.id)) : workers;
      const workerIds = targeted.map((w) => w.id);

      this.log?.info("Hot restart initiated", { reason, workerIds });
      this.safeEmit("restart:start", { reason, workerIds });

      const restartedWorkerIds: number[] = [];

      for (const oldWorker of targeted) {
        if (this.shutdownCoordinator.isShutdownInProgress()) {
          this.log?.info("Shutdown started during hot restart, aborting", { reason });
          break;
        }

        // Mark for recycling so processRestartQueue capacity accounting is correct
        this.workerManager.markForRecycling(oldWorker.id);

        // Fork replacement (with optional env overlay)
        const newWorker = this.workerManager.forkWorker(opts?.env);

        // Wire up drain of old worker (fork-then-drain pattern)
        this.handleWorkerRecycle(oldWorker, newWorker);

        // Wait for the old worker to exit
        await once(oldWorker, "exit");

        restartedWorkerIds.push(oldWorker.id);

        // Stagger before forking the next replacement
        if (staggerMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, staggerMs));
        }
      }

      this.log?.info("Hot restart complete", { reason, restartedWorkerIds });
      this.safeEmit("restart:complete", { restartedWorkerIds, reason });
    } finally {
      this.restartInProgress = false;
    }
  }
```

- [ ] **Step 3: Add the `once` import**

At the top of `packages/worker-manager/src/orchestrator.ts`, add to the `node:events` import (line 2):

```ts
import { EventEmitter, once } from "node:events";
```

- [ ] **Step 4: Write failing tests**

In `packages/worker-manager/test/orchestrator.test.ts`, add the following tests. Place them after the existing recycle tests (search for the last recycle-related test block and add after it):

```ts
  // ─── restartWorkers() ──────────────────────────────────────────────

  it("restartWorkers replaces all workers with rolling restart", async () => {
    const { orchestrator, mockCluster } = await setupPrimary(3);
    const originalIds = Object.values(mockCluster.workers ?? {}).map((w) => w!.id);

    const restartStartEvents: Array<{ reason: string; workerIds: number[] }> = [];
    const restartCompleteEvents: Array<{ restartedWorkerIds: number[]; reason: string }> = [];
    orchestrator.on("restart:start", (d) => restartStartEvents.push(d));
    orchestrator.on("restart:complete", (d) => restartCompleteEvents.push(d));

    // Use staggerMs 0 for fast test
    await orchestrator.restartWorkers({ staggerMs: 0, reason: "test" });

    expect(restartStartEvents).toHaveLength(1);
    expect(restartStartEvents[0].reason).toBe("test");
    expect(restartStartEvents[0].workerIds).toHaveLength(3);

    expect(restartCompleteEvents).toHaveLength(1);
    expect(restartCompleteEvents[0].restartedWorkerIds).toHaveLength(3);
    expect(restartCompleteEvents[0].reason).toBe("test");

    // All original workers should have exited
    for (const id of originalIds) {
      const w = mockCluster.workers?.[id];
      expect(w?.isDead()).toBe(true);
    }
  });

  it("restartWorkers is idempotent — second call during restart is a no-op", async () => {
    const { orchestrator } = await setupPrimary(2);

    const p1 = orchestrator.restartWorkers({ staggerMs: 50, reason: "first" });
    const p2 = orchestrator.restartWorkers({ staggerMs: 50, reason: "second" });

    await Promise.all([p1, p2]);

    // Only the first restart should emit restart:complete
    const completeEvents: Array<{ reason: string }> = [];
    orchestrator.on("restart:complete", (d) => completeEvents.push(d));
    // No new events should fire after both promises settled
    await new Promise((r) => setTimeout(r, 100));
    expect(completeEvents).toHaveLength(0);
  });

  it("restartWorkers returns early in single-worker mode", async () => {
    const orchestrator = new Orchestrator({
      clusterModule: mockCluster,
      workers: { count: 1 },
    });
    mockCluster.isPrimary = true;
    await orchestrator.run();

    const events: Array<{ reason: string }> = [];
    orchestrator.on("restart:start", (d) => events.push(d));

    await orchestrator.restartWorkers({ reason: "test" });

    expect(events).toHaveLength(0);
  });

  it("restartWorkers passes env overlay to forked workers", async () => {
    const { orchestrator, mockCluster } = await setupPrimary(2);

    await orchestrator.restartWorkers({ env: { HOT_RESTART_KEY: "value" }, staggerMs: 0, reason: "env-test" });

    // New workers should have been forked with the overlay env
    const forkCalls = mockCluster.fork.mock.calls;
    // The restart calls forkWorker with env overlay — check at least one call has the overlay
    const hasOverlay = forkCalls.some(
      (call: unknown[]) => call[0] && (call[0] as NodeJS.ProcessEnv).HOT_RESTART_KEY === "value",
    );
    expect(hasOverlay).toBe(true);
  });

  it("restartWorkers respects filter to restart only matching workers", async () => {
    const { orchestrator, mockCluster } = await setupPrimary(3);
    const allIds = Object.values(mockCluster.workers ?? {}).map((w) => w!.id);
    const targetId = allIds[0];

    const completeEvents: Array<{ restartedWorkerIds: number[] }> = [];
    orchestrator.on("restart:complete", (d) => completeEvents.push(d));

    await orchestrator.restartWorkers({
      filter: (id) => id === targetId,
      staggerMs: 0,
      reason: "filter-test",
    });

    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].restartedWorkerIds).toEqual([targetId]);
  });
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit exec vitest run test/orchestrator.test.ts -t "restartWorkers"`
Expected: FAIL — method doesn't exist yet or tests can't find it.

- [ ] **Step 6: Build and run tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit build && corepack pnpm --filter @goopil/clusterkit test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/worker-manager/src/orchestrator.ts packages/worker-manager/test/orchestrator.test.ts
git commit -m "feat(core): add Orchestrator.restartWorkers() for hot rolling restarts"
```

---

## Task 4: Core — Update README documentation

**Files:**
- Modify: `packages/worker-manager/README.md:143-155` (events table)
- Modify: `README.md:140-164` (API section) and `README.md:166-183` (Events section)

- [ ] **Step 1: Update the events table in worker-manager README**

In `packages/worker-manager/README.md`, add the two new events to the table after `circuit-breaker:tripped` (line 154):

```markdown
| `restart:start` | A hot restart cycle begins via `restartWorkers()`. |
| `restart:complete` | A hot restart cycle finishes — all targeted workers replaced. |
```

- [ ] **Step 2: Update the API section in root README**

In `README.md`, add `restartWorkers` to the API code block (after `orchestrator.resetCircuitBreaker()` line):

```ts
orchestrator.restartWorkers(opts);     // rolling-restart workers without dropping connections
```

Add a line after the code block explaining the options:

```
// restartWorkers opts: { env?: NodeJS.ProcessEnv, filter?: (id: number) => boolean, staggerMs?: number, reason?: string }
```

- [ ] **Step 3: Update the Events section in root README**

In `README.md`, add the two new events to the Events code block (after `circuit-breaker:tripped`):

```ts
orchestrator.on('restart:start', ({reason, workerIds}) => {
});
orchestrator.on('restart:complete', ({restartedWorkerIds, reason}) => {
});
```

- [ ] **Step 4: Commit**

```bash
git add packages/worker-manager/README.md README.md
git commit -m "docs(core): document restartWorkers() API and restart events"
```

---

## Task 5: Core — Add changeset

**Files:**
- Create: `.changeset/core-hot-restart.md`

- [ ] **Step 1: Create the changeset**

```bash
source ~/.nvm/nvm.sh && nvm use && corepack pnpm changeset
```

Select `@goopil/clusterkit`, minor, and write:

```markdown
---
"@goopil/clusterkit": minor
---

Add `Orchestrator.restartWorkers()` for hot rolling restarts without dropping connections. Adds `restart:start` and `restart:complete` events. Adds `envOverlay` parameter to `WorkerManager.forkWorker()`.
```

Alternatively, create the file manually at `.changeset/core-hot-restart.md` with the above content.

- [ ] **Step 2: Commit**

```bash
git add .changeset/core-hot-restart.md
git commit -m "changeset: core hot restart API"
```

---

## Task 6: Plugin — Scaffold `plugin-signal-restart` package

**Files:**
- Create: `packages/plugin-signal-restart/package.json`
- Create: `packages/plugin-signal-restart/tsdown.config.ts`
- Create: `packages/plugin-signal-restart/tsconfig.json`
- Create: `packages/plugin-signal-restart/vitest.config.ts`
- Create: `packages/plugin-signal-restart/LICENSE` (copy from `packages/plugin-container-sizing/LICENSE`)
- Create: `packages/plugin-signal-restart/src/index.ts`
- Create: `packages/plugin-signal-restart/test/signal-restart.test.ts`

**Interfaces:**
- Consumes: `OrchestratorPlugin`, `Orchestrator`, `Logger`, `ResolvedConfig`, `withLoggerPrefix` from `@goopil/clusterkit`
- Produces: `createSignalRestartPlugin(options?): SignalRestartPlugin`, `SignalRestartOptions`, `SignalRestartPlugin`

- [ ] **Step 1: Create `package.json`**

Create `packages/plugin-signal-restart/package.json` (modeled on `plugin-container-sizing` — no external peer dep):

```json
{
  "name": "@goopil/clusterkit-signal-restart",
  "version": "0.1.0",
  "description": "Signal-based hot restart plugin for @goopil/clusterkit: SIGHUP triggers rolling worker restart",
  "keywords": ["cluster", "clusterkit", "sighup", "restart", "hot-reload", "rolling-restart"],
  "homepage": "https://github.com/Goopil/clusterkit#readme",
  "bugs": { "url": "https://github.com/Goopil/clusterkit/issues" },
  "repository": { "type": "git", "url": "git+https://github.com/Goopil/clusterkit.git", "directory": "packages/plugin-signal-restart" },
  "license": "LGPL-3.0-or-later",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.mts",
  "sideEffects": false,
  "engines": { "node": ">=22.12.0" },
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  },
  "files": ["dist"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "prepublishOnly": "pnpm build",
    "clean": "rm -rf dist coverage"
  },
  "peerDependencies": { "@goopil/clusterkit": "workspace:*" },
  "devDependencies": {
    "@goopil/clusterkit": "workspace:*",
    "@types/node": "catalog:",
    "@vitest/coverage-v8": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 2: Create `tsdown.config.ts`**

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  target: "es2022",
  outDir: "dist",
});
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov", "html"],
      exclude: ["node_modules/**", "dist/**", "**/*.d.ts", "**/*.config.ts", "test/**"],
      thresholds: { lines: 85, functions: 85, branches: 75, statements: 85 },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
```

- [ ] **Step 5: Copy LICENSE**

```bash
cp packages/plugin-container-sizing/LICENSE packages/plugin-signal-restart/LICENSE
```

- [ ] **Step 6: Create `src/index.ts`**

Create `packages/plugin-signal-restart/src/index.ts`:

```ts
import cluster from "node:cluster";
import {
  type Logger,
  type Orchestrator,
  type OrchestratorPlugin,
  type ResolvedConfig,
  withLoggerPrefix,
} from "@goopil/clusterkit";

export interface SignalRestartOptions {
  /** Signal to listen for. @default "SIGHUP" */
  signal?: NodeJS.Signals;
  /** Delay between draining worker N and starting worker N+1. @default 1000 */
  staggerMs?: number;
  /** Free-form reason string passed to restartWorkers. @default "signal:SIGHUP" */
  reason?: string;
}

export interface SignalRestartPlugin extends OrchestratorPlugin {
  /** Timestamp of the last successful restart, or undefined if none yet. */
  readonly lastRestart: Date | undefined;
}

export function createSignalRestartPlugin(
  options?: SignalRestartOptions,
): SignalRestartPlugin {
  const signal = options?.signal ?? "SIGHUP";
  const staggerMs = options?.staggerMs ?? 1_000;
  const defaultReason = options?.reason ?? `signal:${signal}`;

  let handler: (() => void) | undefined;
  let lastRestart: Date | undefined;

  return {
    name: "signal-restart",
    get lastRestart() {
      return lastRestart;
    },

    async install(
      orchestrator: Orchestrator,
      logger: Logger | null,
      config: ResolvedConfig,
    ): Promise<void> {
      if (!cluster.isPrimary) return;

      const log = withLoggerPrefix(logger, "clusterkit:signal-restart");

      handler = async () => {
        const reason = defaultReason;

        if (config.workers.count === 1) {
          log?.info("Signal received in single-worker mode, exiting for external restart", {
            signal,
            reason,
          });
          process.kill(process.pid, "SIGTERM");
          return;
        }

        log?.info("Signal received, initiating hot restart", { signal, reason });
        try {
          await orchestrator.restartWorkers({ staggerMs, reason });
          lastRestart = new Date();
        } catch (err) {
          log?.error("Hot restart failed", {
            reason,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      process.on(signal, handler);
      log?.debug("Signal restart plugin installed", { signal });
    },

    async uninstall(): Promise<void> {
      if (handler && cluster.isPrimary) {
        process.off(signal, handler);
        handler = undefined;
      }
    },
  };
}
```

- [ ] **Step 7: Write unit tests**

Create `packages/plugin-signal-restart/test/signal-restart.test.ts`:

```ts
import cluster from "node:cluster";
import { EventEmitter } from "node:events";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Logger, Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
import { createSignalRestartPlugin } from "../src/index";

vi.mock("node:cluster", () => ({ default: { isPrimary: true } }));

function mockOrchestrator(): Orchestrator {
  const emitter = new EventEmitter() as Orchestrator & {
    restartWorkers: ReturnType<typeof vi.fn>;
  };
  (emitter as unknown as { restartWorkers: ReturnType<typeof vi.fn> }).restartWorkers = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

function mockConfig(count: number | "auto" = 2): ResolvedConfig {
  return {
    logger: null,
    workers: { count, env: undefined, execArgv: undefined, maxAgeMs: 0 },
    restart: { crashThreshold: 5, crashWindowMs: 60_000, backoffMs: 1_000, maxBackoffMs: 30_000, backoffMultiplier: 2, stabilityWindowMs: 30_000 },
    shutdown: { timeoutMs: 12_000, ackTimeoutMs: 3_000, messagePrefix: "__wm", sigtermDelayMs: 2_000, sigintDelayMs: 1_000 },
    clusterModule: undefined,
  };
}

describe("signal-restart plugin", () => {
  let handlers: Array<{ signal: string; handler: (...args: unknown[]) => void }>;

  beforeEach(() => {
    handlers = [];
    vi.spyOn(process, "on").mockImplementation((signal: string, handler: (...args: unknown[]) => void) => {
      handlers.push({ signal, handler });
      return process;
    });
    vi.spyOn(process, "off").mockImplementation((signal: string, handler: (...args: unknown[]) => void) => {
      handlers = handlers.filter((h) => !(h.signal === signal && h.handler === handler));
      return process;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a SIGHUP listener by default", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig());

    expect(handlers.some((h) => h.signal === "SIGHUP")).toBe(true);
  });

  it("registers a custom signal when configured", async () => {
    const plugin = createSignalRestartPlugin({ signal: "SIGUSR2" });
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig());

    expect(handlers.some((h) => h.signal === "SIGUSR2")).toBe(true);
    expect(handlers.some((h) => h.signal === "SIGHUP")).toBe(false);
  });

  it("calls restartWorkers on signal in multi-worker mode", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();
    const restartWorkers = (orch as unknown as { restartWorkers: ReturnType<typeof vi.fn> }).restartWorkers;

    await plugin.install(orch, null, mockConfig(3));

    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(restartWorkers).toHaveBeenCalledWith({ staggerMs: 1000, reason: "signal:SIGHUP" });
    expect(plugin.lastRestart).toBeInstanceOf(Date);
  });

  it("sends SIGTERM to self in single-worker mode", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    await plugin.install(orch, null, mockConfig(1));

    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    killSpy.mockRestore();
  });

  it("does not register listener in worker process", async () => {
    Object.defineProperty(cluster, "isPrimary", { value: false, configurable: true });
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig());

    expect(handlers).toHaveLength(0);
    Object.defineProperty(cluster, "isPrimary", { value: true, configurable: true });
  });

  it("removes the listener on uninstall", async () => {
    const plugin = createSignalRestartPlugin();
    const orch = mockOrchestrator();

    await plugin.install(orch, null, mockConfig());
    expect(handlers).toHaveLength(1);

    await plugin.uninstall?.(orch);
    expect(handlers).toHaveLength(0);
  });

  it("passes custom staggerMs and reason to restartWorkers", async () => {
    const plugin = createSignalRestartPlugin({ staggerMs: 500, reason: "custom" });
    const orch = mockOrchestrator();
    const restartWorkers = (orch as unknown as { restartWorkers: ReturnType<typeof vi.fn> }).restartWorkers;

    await plugin.install(orch, null, mockConfig(3));

    const sighupHandler = handlers.find((h) => h.signal === "SIGHUP")!.handler;
    await sighupHandler();

    expect(restartWorkers).toHaveBeenCalledWith({ staggerMs: 500, reason: "custom" });
  });
});
```

- [ ] **Step 8: Install and build**

```bash
source ~/.nvm/nvm.sh && nvm use && corepack pnpm install && corepack pnpm --filter @goopil/clusterkit-signal-restart build
```

- [ ] **Step 9: Run unit tests**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit-signal-restart test`
Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add packages/plugin-signal-restart/
git commit -m "feat(signal-restart): scaffold plugin package with SIGHUP hot restart"
```

---

## Task 7: Plugin — Signal-restart integration tests

**Files:**
- Create: `packages/plugin-signal-restart/test/signal-restart.integration.test.ts`

**Interfaces:**
- Consumes: `Orchestrator` from `@goopil/clusterkit`, `createSignalRestartPlugin` from `../src/index`, worker fixture at `../../worker-manager/test/fixtures/process-worker.cjs`

- [ ] **Step 1: Write integration tests**

Create `packages/plugin-signal-restart/test/signal-restart.integration.test.ts`:

```ts
import cluster from "node:cluster";
import { once } from "node:events";
import { resolve } from "node:path";
import { vi, describe, it, expect, afterEach } from "vitest";
import { Orchestrator } from "@goopil/clusterkit";
import { createSignalRestartPlugin } from "../src/index";

const WORKER_FIXTURE_PATH = resolve(__dirname, "../../worker-manager/test/fixtures/process-worker.cjs");
const PREFIX = "__sigrestart_it";

async function killRemainingWorkers(): Promise<void> {
  const workers = Object.values(cluster.workers ?? {}).filter(
    (w): w is cluster.Worker => w !== undefined,
  );
  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((r) => {
          if (w.isDead()) return r();
          const t = setTimeout(r, 1_500);
          w.once("exit", () => {
            clearTimeout(t);
            r();
          });
          w.process.kill("SIGKILL");
        }),
    ),
  );
}

afterEach(async () => {
  await killRemainingWorkers();
  process.removeAllListeners("SIGHUP");
});

describe("signal-restart integration", () => {
  it("performs rolling restart on SIGHUP in multi-worker mode", async () => {
    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "cooperative", WM_IT_MESSAGE_PREFIX: PREFIX },
      },
      shutdown: { timeoutMs: 4_000, ackTimeoutMs: 1_000, messagePrefix: PREFIX },
    });

    const plugin = createSignalRestartPlugin({ staggerMs: 100 });
    orchestrator.use(plugin);
    await orchestrator.run();

    // Wait for 2 workers online
    const onlineP = Promise.all([
      once(orchestrator, "worker:online"),
      once(orchestrator, "worker:online"),
    ]);
    await Promise.race([onlineP, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 5_000))]);

    const originalIds = Object.values(cluster.workers ?? {})
      .filter((w) => w !== undefined)
      .map((w) => w!.id)
      .sort();

    // Trigger restart
    const completeP = once(orchestrator, "restart:complete");
    process.emit("SIGHUP");
    await completeP;

    // Verify new worker IDs differ from originals
    const newIds = Object.values(cluster.workers ?? {})
      .filter((w) => w !== undefined && !w!.isDead())
      .map((w) => w!.id)
      .sort();

    expect(newIds).not.toEqual(originalIds);

    // Clean shutdown
    const shutdownP = once(orchestrator, "shutdown:complete");
    process.emit("SIGTERM");
    await shutdownP;
  }, 15_000);

  it("exits on SIGHUP in single-worker mode", async () => {
    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: { count: 1 },
      shutdown: { timeoutMs: 4_000, ackTimeoutMs: 1_000, messagePrefix: PREFIX },
    });

    const plugin = createSignalRestartPlugin();
    orchestrator.use(plugin);
    await orchestrator.run();

    // SIGHUP in single-worker mode should trigger SIGTERM → shutdown
    const shutdownP = once(orchestrator, "shutdown:complete");

    // Use process.kill to deliver a real signal (process.emit won't trigger
    // the plugin handler the same way for single-worker path)
    process.emit("SIGHUP");

    await Promise.race([
      shutdownP,
      new Promise((_, r) => setTimeout(() => r(new Error("shutdown timeout")), 8_000)),
    ]);

    expect(orchestrator.getHealth().ready).toBe(false);
  }, 15_000);
});
```

- [ ] **Step 2: Run integration tests**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit-signal-restart exec vitest run test/signal-restart.integration.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-signal-restart/test/signal-restart.integration.test.ts
git commit -m "test(signal-restart): add integration tests with real Orchestrator"
```

---

## Task 8: Plugin — Signal-restart README and changeset

**Files:**
- Create: `packages/plugin-signal-restart/README.md`
- Create: `.changeset/signal-restart.md`

- [ ] **Step 1: Create README**

Create `packages/plugin-signal-restart/README.md`:

````markdown
# @goopil/clusterkit-signal-restart

Signal-based hot restart plugin for [@goopil/clusterkit](https://github.com/Goopil/clusterkit). Listens for `SIGHUP` (or a custom signal) and triggers a rolling worker restart without dropping connections.

## Installation

```bash
pnpm add @goopil/clusterkit-signal-restart
```

## Usage

```js
import { Orchestrator } from "@goopil/clusterkit";
import { createSignalRestartPlugin } from "@goopil/clusterkit-signal-restart";

const orchestrator = new Orchestrator({ logger: console });

orchestrator
  .use(createSignalRestartPlugin())        // SIGHUP → rolling restart
  .run(async () => {
    // Your server here
  });
```

Send `SIGHUP` to the process to trigger a rolling restart:

```bash
kill -HUP <pid>
```

## Single-worker mode

In single-worker mode (`workers: { count: 1 }`), there is no cluster to roll. The plugin delivers `SIGTERM` to self, triggering the normal graceful shutdown for external restart (e.g. by a process manager).

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `signal` | `NodeJS.Signals` | `"SIGHUP"` | Signal to listen for. |
| `staggerMs` | `number` | `1000` | Delay between draining worker N and starting worker N+1. Passed to `restartWorkers()`. |
| `reason` | `string` | `"signal:SIGHUP"` | Free-form reason string for `restart:start`/`restart:complete` events. |

## API

### `createSignalRestartPlugin(options?): SignalRestartPlugin`

Factory returning a plugin implementing `OrchestratorPlugin`.

### `SignalRestartPlugin`

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | `"signal-restart"` |
| `lastRestart` | `Date \| undefined` | Timestamp of the last successful restart. |

## Events

The plugin does not emit its own events. It relies on the core's `restart:start`, `restart:complete`, `worker:recycle`, and `worker:restart` events.
````

- [ ] **Step 2: Create changeset**

Create `.changeset/signal-restart.md`:

```markdown
---
"@goopil/clusterkit-signal-restart": minor
---

Initial release: signal-based hot restart plugin. Listens for SIGHUP (or custom signal) and triggers `Orchestrator.restartWorkers()` for rolling worker restarts without dropping connections.
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-signal-restart/README.md .changeset/signal-restart.md
git commit -m "docs(signal-restart): add README and changeset"
```

---

## Task 9: Plugin — Scaffold `plugin-file-watcher` package and `parseEnvFile`

**Files:**
- Create: `packages/plugin-file-watcher/package.json`
- Create: `packages/plugin-file-watcher/tsdown.config.ts`
- Create: `packages/plugin-file-watcher/tsconfig.json`
- Create: `packages/plugin-file-watcher/vitest.config.ts`
- Create: `packages/plugin-file-watcher/LICENSE` (copy from `packages/plugin-container-sizing/LICENSE`)
- Create: `packages/plugin-file-watcher/src/parse-env.ts`
- Create: `packages/plugin-file-watcher/src/index.ts`
- Create: `packages/plugin-file-watcher/test/file-watcher.test.ts`

**Interfaces:**
- Consumes: `OrchestratorPlugin`, `Orchestrator`, `Logger`, `ResolvedConfig`, `withLoggerPrefix` from `@goopil/clusterkit`; `chokidar` (^4 peer dep)
- Produces: `createFileWatcherPlugin(options?): FileWatcherPlugin`, `FileWatcherOptions`, `FileWatcherPlugin`, `parseEnvFile(content: string): Record<string, string>`

- [ ] **Step 1: Create `package.json`**

Create `packages/plugin-file-watcher/package.json` (modeled on `plugin-prometheus` — has external peer dep):

```json
{
  "name": "@goopil/clusterkit-file-watcher",
  "version": "0.1.0",
  "description": "File watcher hot restart plugin for @goopil/clusterkit: watches files, .env, and process.env for changes and triggers rolling worker restarts",
  "keywords": ["cluster", "clusterkit", "file-watcher", "hot-reload", "chokidar", "rolling-restart", "env"],
  "homepage": "https://github.com/Goopil/clusterkit#readme",
  "bugs": { "url": "https://github.com/Goopil/clusterkit/issues" },
  "repository": { "type": "git", "url": "git+https://github.com/Goopil/clusterkit.git", "directory": "packages/plugin-file-watcher" },
  "license": "LGPL-3.0-or-later",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.mts",
  "sideEffects": false,
  "engines": { "node": ">=22.12.0" },
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  },
  "files": ["dist"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "prepublishOnly": "pnpm build",
    "clean": "rm -rf dist coverage"
  },
  "peerDependencies": {
    "@goopil/clusterkit": "workspace:*",
    "chokidar": "^4"
  },
  "devDependencies": {
    "@goopil/clusterkit": "workspace:*",
    "@types/node": "catalog:",
    "@vitest/coverage-v8": "catalog:",
    "chokidar": "^4.0.0",
    "tsdown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 2: Create `tsdown.config.ts`, `tsconfig.json`, `vitest.config.ts`**

Copy from `packages/plugin-signal-restart/` (identical templates created in Task 6).

- [ ] **Step 3: Copy LICENSE**

```bash
cp packages/plugin-container-sizing/LICENSE packages/plugin-file-watcher/LICENSE
```

- [ ] **Step 4: Create `src/parse-env.ts`**

Create `packages/plugin-file-watcher/src/parse-env.ts`:

```ts
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}
```

- [ ] **Step 5: Write `parseEnvFile` unit tests**

Create `packages/plugin-file-watcher/test/file-watcher.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Orchestrator, ResolvedConfig } from "@goopil/clusterkit";
import { parseEnvFile } from "../src/parse-env";

describe("parseEnvFile", () => {
  it("parses simple KEY=VALUE pairs", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips empty lines", () => {
    const result = parseEnvFile("FOO=bar\n\nBAZ=qux\n\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips comments starting with #", () => {
    const result = parseEnvFile("# comment\nFOO=bar\n# another\nBAZ=qux");
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

  it("skips lines without =", () => {
    const result = parseEnvFile("FOO=bar\nINVALID\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
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
```

- [ ] **Step 6: Run `parseEnvFile` tests**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit-file-watcher install && corepack pnpm --filter @goopil/clusterkit-file-watcher exec vitest run test/file-watcher.test.ts -t "parseEnvFile"`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-file-watcher/package.json packages/plugin-file-watcher/tsdown.config.ts packages/plugin-file-watcher/tsconfig.json packages/plugin-file-watcher/vitest.config.ts packages/plugin-file-watcher/LICENSE packages/plugin-file-watcher/src/parse-env.ts packages/plugin-file-watcher/test/file-watcher.test.ts
git commit -m "feat(file-watcher): scaffold package with parseEnvFile utility"
```

---

## Task 10: Plugin — File-watcher implementation

**Files:**
- Create: `packages/plugin-file-watcher/src/index.ts`
- Modify: `packages/plugin-file-watcher/test/file-watcher.test.ts` (add plugin tests)

**Interfaces:**
- Consumes: `parseEnvFile` from `./parse-env.ts`, `OrchestratorPlugin`, `Orchestrator`, `Logger`, `ResolvedConfig`, `withLoggerPrefix` from `@goopil/clusterkit`, `chokidar` (^4)
- Produces: `createFileWatcherPlugin(options?): FileWatcherPlugin`, `FileWatcherOptions`, `FileWatcherPlugin`

- [ ] **Step 1: Create `src/index.ts`**

Create `packages/plugin-file-watcher/src/index.ts`:

```ts
import cluster from "node:cluster";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  type Logger,
  type Orchestrator,
  type OrchestratorPlugin,
  type ResolvedConfig,
  withLoggerPrefix,
} from "@goopil/clusterkit";
import chokidar, { type FSWatcher } from "chokidar";
import { parseEnvFile } from "./parse-env";

export { parseEnvFile } from "./parse-env";

export interface FileWatcherOptions {
  /** Globs/paths to watch for file changes. */
  watch?: string[] | string;
  /** Options passed through to chokidar. */
  watchOptions?: chokidar.WatchOptions;
  /** Globs to ignore. */
  ignore?: string[] | string;

  /** Path(s) to .env files to parse on change. */
  envFile?: string | string[];
  /** Custom .env parser (default: simple KEY=VALUE parser). */
  envParser?: (content: string) => Record<string, string>;

  /** Poll process.env for changes. @default false */
  pollEnv?: boolean;
  /** Interval for process.env polling. @default 5000 */
  pollEnvIntervalMs?: number;

  /** Debounce time for coalescing rapid changes. @default 300 */
  debounceMs?: number;
  /** Delay between draining worker N and starting worker N+1. @default 1000 */
  staggerMs?: number;
  /** Reason string for restart events. @default "file-change" or "env-change" */
  reason?: string;

  /** Delay before starting watchers. @default 0 */
  startDelayMs?: number;

  /** Log what would restart without actually restarting. @default false */
  dryRun?: boolean;
}

export interface FileWatcherPlugin extends OrchestratorPlugin {
  readonly isWatching: boolean;
}

export function createFileWatcherPlugin(
  options?: FileWatcherOptions,
): FileWatcherPlugin {
  const watchPaths = options?.watch
    ? Array.isArray(options.watch)
      ? options.watch
      : [options.watch]
    : [];
  const ignorePaths = options?.ignore
    ? Array.isArray(options.ignore)
      ? options.ignore
      : [options.ignore]
    : [];
  const envFiles = options?.envFile
    ? Array.isArray(options.envFile)
      ? options.envFile
      : [options.envFile]
    : [];
  const envParser = options?.envParser ?? parseEnvFile;
  const pollEnv = options?.pollEnv ?? false;
  const pollEnvIntervalMs = options?.pollEnvIntervalMs ?? 5_000;
  const debounceMs = options?.debounceMs ?? 300;
  const staggerMs = options?.staggerMs ?? 1_000;
  const startDelayMs = options?.startDelayMs ?? 0;
  const dryRun = options?.dryRun ?? false;
  const defaultReason = options?.reason;

  let watchers: FSWatcher[] = [];
  let envPollInterval: NodeJS.Timeout | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let envSnapshot: Map<string, string> | undefined;
  let watching = false;

  return {
    name: "file-watcher",
    get isWatching() {
      return watching;
    },

    async install(
      orchestrator: Orchestrator,
      logger: Logger | null,
      config: ResolvedConfig,
    ): Promise<void> {
      if (!cluster.isPrimary) return;

      const log = withLoggerPrefix(logger, "clusterkit:file-watcher");

      if (config.workers.count === 1) {
        log?.warn("file-watcher plugin has no effect in single-worker mode");
        return;
      }

      const triggerRestart = (reason: string, env?: NodeJS.ProcessEnv): void => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          debounceTimer = undefined;
          if (dryRun) {
            log?.info("Dry run — would trigger hot restart", { reason });
            return;
          }
          log?.info("Triggering hot restart", { reason });
          try {
            await orchestrator.restartWorkers({ env, staggerMs, reason });
          } catch (err) {
            log?.error("Hot restart failed", {
              reason,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, debounceMs).unref();
      };

      const startWatchers = (): void => {
        // File watchers — chokidar for glob support and cross-platform reliability
        if (watchPaths.length > 0) {
          const chokidarOpts: chokidar.WatchOptions = {
            ignored: ignorePaths.length > 0 ? ignorePaths : undefined,
            ...options?.watchOptions,
          };
          try {
            const w = chokidar.watch(watchPaths, chokidarOpts);
            const envAbsPaths = new Set(envFiles.map((f) => resolvePath(f)));
            w.on("change", (filePath) => {
              if (envAbsPaths.has(resolvePath(filePath))) return; // handled by env watcher
              log?.debug("File changed", { file: filePath });
              triggerRestart(defaultReason ?? "file-change");
            });
            w.on("add", (filePath) => {
              if (envAbsPaths.has(resolvePath(filePath))) return;
              log?.debug("File added", { file: filePath });
              triggerRestart(defaultReason ?? "file-change");
            });
            w.on("unlink", (filePath) => {
              if (envAbsPaths.has(resolvePath(filePath))) return;
              log?.debug("File removed", { file: filePath });
              triggerRestart(defaultReason ?? "file-change");
            });
            watchers.push(w);
          } catch (err) {
            log?.error("Failed to start file watcher", {
              paths: watchPaths,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // .env file watchers — separate chokidar instance for .env files
        if (envFiles.length > 0) {
          try {
            const w = chokidar.watch(envFiles, {
              ...options?.watchOptions,
            });
            w.on("change", (filePath) => {
              log?.debug(".env file changed", { file: filePath });
              try {
                const content = readFileSync(resolvePath(filePath), "utf-8");
                const parsed = envParser(content);
                triggerRestart(defaultReason ?? "env-change", parsed);
              } catch (err) {
                log?.error("Failed to read/parse .env file", {
                  file: filePath,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            });
            watchers.push(w);
          } catch (err) {
            log?.error("Failed to start .env file watcher", {
              files: envFiles,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // process.env polling
        if (pollEnv) {
          envSnapshot = new Map(Object.entries(process.env));
          envPollInterval = setInterval(() => {
            const current = new Map(Object.entries(process.env));
            let changed = false;
            for (const [key, value] of current) {
              if (envSnapshot!.get(key) !== value) {
                changed = true;
                break;
              }
            }
            if (!changed) {
              for (const [key] of envSnapshot!) {
                if (!current.has(key)) {
                  changed = true;
                  break;
                }
              }
            }
            if (changed) {
              log?.debug("process.env changed, triggering restart");
              envSnapshot = current;
              triggerRestart(defaultReason ?? "env-change", { ...process.env });
            }
          }, pollEnvIntervalMs).unref();
        }

        watching = true;
        log?.debug("File watcher started", {
          watchPaths,
          envFiles,
          pollEnv,
          dryRun,
        });
      };

      const start = (): void => {
        if (startDelayMs > 0) {
          setTimeout(startWatchers, startDelayMs).unref();
        } else {
          startWatchers();
        }
      };

      start();

      orchestrator.registerOnShutdown(() => {
        for (const w of watchers) w.close();
        watchers = [];
        if (envPollInterval) {
          clearInterval(envPollInterval);
          envPollInterval = undefined;
        }
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = undefined;
        }
        watching = false;
      });
    },

    async uninstall(): Promise<void> {
      for (const w of watchers) w.close();
      watchers = [];
      if (envPollInterval) {
        clearInterval(envPollInterval);
        envPollInterval = undefined;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      watching = false;
    },
  };
}
```

- [ ] **Step 2: Add plugin unit tests**

Append to `packages/plugin-file-watcher/test/file-watcher.test.ts`:

```ts
import cluster from "node:cluster";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileWatcherPlugin } from "../src/index";

vi.mock("node:cluster", () => ({ default: { isPrimary: true } }));

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
    restart: { crashThreshold: 5, crashWindowMs: 60_000, backoffMs: 1_000, maxBackoffMs: 30_000, backoffMultiplier: 2, stabilityWindowMs: 30_000 },
    shutdown: { timeoutMs: 12_000, ackTimeoutMs: 3_000, messagePrefix: "__wm", sigtermDelayMs: 2_000, sigintDelayMs: 1_000 },
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

    // Trigger a file change
    writeFileSync(tempFile, "changed");

    // Wait for debounce + buffer
    await new Promise((r) => setTimeout(r, 300));

    expect(orch.restartWorkers).toHaveBeenCalledTimes(1);
    expect(orch.restartWorkers).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "file-change", staggerMs: 0 }),
    );

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
});
```

- [ ] **Step 3: Install and build**

```bash
source ~/.nvm/nvm.sh && nvm use && corepack pnpm install && corepack pnpm --filter @goopil/clusterkit-file-watcher build
```

- [ ] **Step 4: Run unit tests**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit-file-watcher test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-file-watcher/src/index.ts packages/plugin-file-watcher/test/file-watcher.test.ts
git commit -m "feat(file-watcher): implement file/env watching plugin with dryRun mode"
```

---

## Task 11: Plugin — File-watcher integration tests

**Files:**
- Create: `packages/plugin-file-watcher/test/file-watcher.integration.test.ts`

- [ ] **Step 1: Write integration tests**

Create `packages/plugin-file-watcher/test/file-watcher.integration.test.ts`:

```ts
import cluster from "node:cluster";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { resolve } from "node:path";
import { vi, describe, it, expect, afterEach } from "vitest";
import { Orchestrator } from "@goopil/clusterkit";
import { createFileWatcherPlugin } from "../src/index";

const WORKER_FIXTURE_PATH = resolve(__dirname, "../../worker-manager/test/fixtures/process-worker.cjs");
const PREFIX = "__fw_it";

async function killRemainingWorkers(): Promise<void> {
  const workers = Object.values(cluster.workers ?? {}).filter(
    (w): w is cluster.Worker => w !== undefined,
  );
  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((r) => {
          if (w.isDead()) return r();
          const t = setTimeout(r, 1_500);
          w.once("exit", () => {
            clearTimeout(t);
            r();
          });
          w.process.kill("SIGKILL");
        }),
    ),
  );
}

afterEach(async () => {
  await killRemainingWorkers();
});

describe("file-watcher integration", () => {
  it("triggers rolling restart on file change", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-int-"));
    const tempFile = join(tempDir, "app.txt");
    writeFileSync(tempFile, "initial");

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "cooperative", WM_IT_MESSAGE_PREFIX: PREFIX },
      },
      shutdown: { timeoutMs: 4_000, ackTimeoutMs: 1_000, messagePrefix: PREFIX },
    });

    const plugin = createFileWatcherPlugin({
      watch: [tempDir],
      debounceMs: 100,
      staggerMs: 100,
    });
    orchestrator.use(plugin);
    await orchestrator.run();

    // Wait for 2 workers online
    const onlineP = Promise.all([
      once(orchestrator, "worker:online"),
      once(orchestrator, "worker:online"),
    ]);
    await Promise.race([onlineP, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 5_000))]);

    const originalIds = Object.values(cluster.workers ?? {})
      .filter((w) => w !== undefined)
      .map((w) => w!.id)
      .sort();

    // Trigger file change
    const completeP = once(orchestrator, "restart:complete");
    writeFileSync(tempFile, "changed");
    await completeP;

    // Verify new worker IDs differ
    const newIds = Object.values(cluster.workers ?? {})
      .filter((w) => w !== undefined && !w!.isDead())
      .map((w) => w!.id)
      .sort();

    expect(newIds).not.toEqual(originalIds);

    // Clean shutdown
    const shutdownP = once(orchestrator, "shutdown:complete");
    process.emit("SIGTERM");
    await shutdownP;

    rmSync(tempDir, { recursive: true, force: true });
  }, 15_000);

  it("triggers rolling restart with new env on .env file change", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fw-env-"));
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "APP_KEY=initial\n");

    cluster.setupPrimary({ exec: WORKER_FIXTURE_PATH });
    const orchestrator = new Orchestrator({
      clusterModule: cluster,
      workers: {
        count: 2,
        env: { WM_IT_MODE: "cooperative", WM_IT_MESSAGE_PREFIX: PREFIX },
      },
      shutdown: { timeoutMs: 4_000, ackTimeoutMs: 1_000, messagePrefix: PREFIX },
    });

    const plugin = createFileWatcherPlugin({
      envFile: [envPath],
      debounceMs: 100,
      staggerMs: 100,
    });
    orchestrator.use(plugin);
    await orchestrator.run();

    // Wait for 2 workers online
    const onlineP = Promise.all([
      once(orchestrator, "worker:online"),
      once(orchestrator, "worker:online"),
    ]);
    await Promise.race([onlineP, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 5_000))]);

    // Modify .env file
    const completeP = once(orchestrator, "restart:complete");
    writeFileSync(envPath, "APP_KEY=updated\nNEW_KEY=new\n");
    await completeP;

    // Verify restart happened
    expect(plugin.isWatching).toBe(true);

    // Clean shutdown
    const shutdownP = once(orchestrator, "shutdown:complete");
    process.emit("SIGTERM");
    await shutdownP;

    rmSync(tempDir, { recursive: true, force: true });
  }, 15_000);
});
```

- [ ] **Step 2: Run integration tests**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm --filter @goopil/clusterkit-file-watcher exec vitest run test/file-watcher.integration.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-file-watcher/test/file-watcher.integration.test.ts
git commit -m "test(file-watcher): add integration tests with real Orchestrator"
```

---

## Task 12: Plugin — File-watcher README and changeset

**Files:**
- Create: `packages/plugin-file-watcher/README.md`
- Create: `.changeset/file-watcher.md`

- [ ] **Step 1: Create README**

Create `packages/plugin-file-watcher/README.md`:

````markdown
# @goopil/clusterkit-file-watcher

File watcher hot restart plugin for [@goopil/clusterkit](https://github.com/Goopil/clusterkit). Watches source files, `.env` files, and/or `process.env` for changes and triggers a rolling worker restart without dropping connections.

## Installation

```bash
pnpm add @goopil/clusterkit-file-watcher
```

## Usage

```js
import { Orchestrator } from "@goopil/clusterkit";
import { createFileWatcherPlugin } from "@goopil/clusterkit-file-watcher";

const orchestrator = new Orchestrator({ logger: console });

orchestrator
  .use(createFileWatcherPlugin({
    watch: ["./src"],       // watch source files
    envFile: "./.env",      // watch .env file
    debounceMs: 300,        // coalesce rapid changes
  }))
  .run(async () => {
    // Your server here
  });
```

## Three watching modes

The plugin supports three independently selectable modes, all of which can be active simultaneously:

1. **File watching** (`watch`): watches files/globs for changes. On change, triggers a debounced rolling restart.
2. **`.env` file watching** (`envFile`): watches `.env` files. On change, re-parses the file and passes the parsed env to `restartWorkers({ env })`.
3. **`process.env` polling** (`pollEnv`): snapshots `process.env` and polls for changes. On diff, triggers a restart with the full `process.env`.

## Single-worker mode

The plugin has no effect in single-worker mode (`workers: { count: 1 }`). A file change does not trigger a full process exit (that would be a crash loop on every save).

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `watch` | `string \| string[]` | `[]` | Globs/paths to watch for file changes. |
| `watchOptions` | `object` | `{}` | Options passed through to the watcher. |
| `ignore` | `string \| string[]` | `[]` | Globs to ignore. |
| `envFile` | `string \| string[]` | `[]` | Path(s) to `.env` files to parse on change. |
| `envParser` | `(content: string) => Record<string, string>` | `parseEnvFile` | Custom `.env` parser. |
| `pollEnv` | `boolean` | `false` | Enable `process.env` polling. |
| `pollEnvIntervalMs` | `number` | `5000` | Interval for `process.env` polling. |
| `debounceMs` | `number` | `300` | Debounce time for coalescing rapid changes. |
| `staggerMs` | `number` | `1000` | Delay between draining worker N and starting worker N+1. |
| `reason` | `string` | `"file-change"` or `"env-change"` | Reason string for restart events. |
| `startDelayMs` | `number` | `0` | Delay before starting watchers. |
| `dryRun` | `boolean` | `false` | Log what would restart without actually restarting. |

## API

### `createFileWatcherPlugin(options?): FileWatcherPlugin`

Factory returning a plugin implementing `OrchestratorPlugin`.

### `parseEnvFile(content: string): Record<string, string>`

Exported utility: parses `.env` file content into a key-value map. Handles comments (`#`), quotes, and empty lines.

### `FileWatcherPlugin`

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | `"file-watcher"` |
| `isWatching` | `boolean` | Whether watchers are currently active. |

## Events

The plugin does not emit its own events. It relies on the core's `restart:start`, `restart:complete`, `worker:recycle`, and `worker:restart` events.
````

- [ ] **Step 2: Create changeset**

Create `.changeset/file-watcher.md`:

```markdown
---
"@goopil/clusterkit-file-watcher": minor
---

Initial release: file watcher hot restart plugin. Watches source files, `.env` files, and `process.env` for changes. Supports debounced rolling restarts, `dryRun` mode, and custom env parsers.
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-file-watcher/README.md .changeset/file-watcher.md
git commit -m "docs(file-watcher): add README and changeset"
```

---

## Task 13: Example — Create `examples/hot-reload` app

**Files:**
- Create: `examples/hot-reload/package.json`
- Create: `examples/hot-reload/src/index.mjs`

- [ ] **Step 1: Create `package.json`**

Create `examples/hot-reload/package.json`:

```json
{
  "name": "example-hot-reload",
  "private": true,
  "main": "src/index.mjs",
  "scripts": {
    "start": "node src/index.mjs",
    "serve": "node --watch src/index.mjs"
  },
  "license": "LGPL-3.0-or-later",
  "packageManager": "pnpm@10.30.1",
  "engines": { "node": ">=20.0.0" },
  "type": "module",
  "dependencies": {
    "@goopil/clusterkit": "workspace:*",
    "@goopil/clusterkit-sizing": "workspace:*",
    "@goopil/clusterkit-signal-restart": "workspace:*",
    "@goopil/clusterkit-file-watcher": "workspace:*",
    "express": "^5.2.1"
  }
}
```

- [ ] **Step 2: Create `src/index.mjs`**

Create `examples/hot-reload/src/index.mjs`:

```js
import { Orchestrator } from "@goopil/clusterkit";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import { createSignalRestartPlugin } from "@goopil/clusterkit-signal-restart";
import { createFileWatcherPlugin } from "@goopil/clusterkit-file-watcher";
import express from "express";

(async () => {
  const orchestrator = new Orchestrator({ logger: console });
  const capabilities = await Orchestrator.getCapabilities();

  console.log("Platform:", capabilities.platform);
  console.log("SO_REUSEPORT:", capabilities.reusePort);

  orchestrator
    .use(createContainerSizingPlugin())
    .use(createSignalRestartPlugin()) // SIGHUP → rolling restart
    .use(
      createFileWatcherPlugin({
        // File changes → rolling restart
        watch: ["./src"],
        envFile: "./.env",
        debounceMs: 300,
      }),
    )
    .run(async () => {
      const app = express();
      app.get("/", (_req, res) => {
        res.json({
          hello: "world",
          pid: process.pid,
          restartKey: process.env.APP_KEY ?? "not-set",
        });
      });

      const server = app.listen({
        port: +(process.env?.PORT || 3010),
        host: "0.0.0.0",
        exclusive: capabilities.reusePort,
        reusePort: capabilities.reusePort,
      });

      orchestrator.registerOnShutdown(() => {
        server.close();
      });

      console.log(`Worker ${process.pid} listening on port ${process.env.PORT || 3010}`);
    });
})();
```

- [ ] **Step 3: Install and build**

```bash
source ~/.nvm/nvm.sh && nvm use && corepack pnpm install && corepack pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add examples/hot-reload/
git commit -m "feat(examples): add hot-reload example with signal + watcher plugins"
```

---

## Task 14: Docs — Update root README and AGENTS.md

**Files:**
- Modify: `README.md` (package table + hot-reload section)
- Modify: `AGENTS.md` (repository map + architecture notes)

- [ ] **Step 1: Update package table in root README**

In `README.md`, add the two new plugins to the Packages table (after the otlp-meter row):

```markdown
| [`@goopil/clusterkit-signal-restart`](#goopilclusterkit-signal-restart) | Signal-based hot restart plugin (SIGHUP → rolling restart) | [`packages/plugin-signal-restart/README.md`](./packages/plugin-signal-restart/README.md) |
| [`@goopil/clusterkit-file-watcher`](#goopilclusterkit-file-watcher) | File watcher hot restart plugin (file/env changes → rolling restart) | [`packages/plugin-file-watcher/README.md`](./packages/plugin-file-watcher/README.md) |
```

- [ ] **Step 2: Add plugin sections to root README**

Add sections after the otlp-meter section in `README.md`:

````markdown
---

## `@goopil/clusterkit-signal-restart`

Detailed package README: [`packages/plugin-signal-restart/README.md`](./packages/plugin-signal-restart/README.md)

Triggers a rolling worker restart on `SIGHUP` (or a custom signal) without dropping connections.

### Installation

```bash
pnpm add @goopil/clusterkit-signal-restart
```

### Usage

```js
import { Orchestrator } from '@goopil/clusterkit';
import { createSignalRestartPlugin } from '@goopil/clusterkit-signal-restart';

const orchestrator = new Orchestrator({ logger: console });

orchestrator
  .use(createSignalRestartPlugin())  // SIGHUP → rolling restart
  .run(async () => { /* ... */ });
```

Send `kill -HUP <pid>` to trigger a rolling restart.

---

## `@goopil/clusterkit-file-watcher`

Detailed package README: [`packages/plugin-file-watcher/README.md`](./packages/plugin-file-watcher/README.md)

Watches source files, `.env` files, and `process.env` for changes and triggers a rolling worker restart.

### Installation

```bash
pnpm add @goopil/clusterkit-file-watcher
```

### Usage

```js
import { Orchestrator } from '@goopil/clusterkit';
import { createFileWatcherPlugin } from '@goopil/clusterkit-file-watcher';

const orchestrator = new Orchestrator({ logger: console });

orchestrator
  .use(createFileWatcherPlugin({
    watch: ['./src'],    // source file changes
    envFile: './.env',  // .env file changes
    debounceMs: 300,
  }))
  .run(async () => { /* ... */ });
```
````

- [ ] **Step 3: Update AGENTS.md repository map**

In `AGENTS.md`, add the two new packages to the repository map:

```markdown
- `packages/plugin-signal-restart/`: signal-based hot restart plugin (`@goopil/clusterkit-signal-restart`)
- `packages/plugin-file-watcher/`: file watcher hot restart plugin (`@goopil/clusterkit-file-watcher`)
```

- [ ] **Step 4: Update AGENTS.md architecture notes**

In `AGENTS.md`, add a "Hot restart" subsection under architecture notes:

```markdown
### Hot restart

`Orchestrator.restartWorkers()` performs a rolling restart: forks a replacement for each
worker, then drains the old one via the existing `handleWorkerRecycle` flow. Emits
`restart:start` and `restart:complete` events. Idempotent via a `restartInProgress` guard.
Returns early in single-worker mode. The `env` overlay parameter passes per-restart env
to newly forked workers without mutating `cfg.workers.env`.

Two plugins trigger it:
- `plugin-signal-restart`: listens for SIGHUP (or custom signal). In single-worker mode,
  delivers SIGTERM for external restart.
- `plugin-file-watcher`: watches files, `.env` files, and/or `process.env` for changes.
  Debounced triggers. Supports `dryRun` mode.
```

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: add hot restart plugins to README and AGENTS.md"
```

---

## Task 15: Final validation

- [ ] **Step 1: Run full workspace lint**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm lint`
Expected: No errors.

- [ ] **Step 2: Run full workspace build**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm build`
Expected: All packages build successfully.

- [ ] **Step 3: Run full workspace tests**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm test`
Expected: All tests pass.

- [ ] **Step 4: Run packaging smoke test**

Run: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm test:packages`
Expected: All packages pass publint.

- [ ] **Step 5: Fix any lint/build/test failures**

If any failures, fix them and re-run the relevant command.

- [ ] **Step 6: Final commit (if fixes were needed)**

```bash
git add -A
git commit -m "fix: resolve lint/test issues from final validation"
```

