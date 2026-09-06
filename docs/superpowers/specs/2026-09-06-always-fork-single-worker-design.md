# Always Fork, Even for a Single Worker (2.0) — Design

Issue: [#168](https://github.com/Goopil/clusterkit/issues/168)

## Goal

`workers.count: 1` always forks one worker. The primary becomes a pure supervisor (signals, fork,
drain, health registry, events) and the application (`start()`) always runs in the worker process,
exactly like `count >= 2` today. This removes the single-worker special cases, enables real
self-healing at count 1 (primary survives app OOM/wedge and restarts the worker with backoff +
circuit breaker), and gives `workers: 'auto'` identical guarantees on 1-vCPU containers.

## Approach

Direct switch to the existing multi-worker path (chosen for being the smallest diff and the only
true single-code-path option; alternatives — pre-refactoring shutdown plumbing, or an intermediate
"light supervisor" mode — were rejected as redundant/speculative: `shutdownPrimary()` is already a
superset of `shutdownSingleWorker()`).

## Behavior changes (breaking, 2.0)

- At `count: 1`, the app runs in a forked worker, not in the primary process.
- `isPrimary` is `false` in the application process at count 1 (was `true`). Plugins that bind
  primary-side resources (e.g. prometheus `serve()`) now behave as in multi-worker mode: one
  primary-side aggregated bind instead of a worker-side bind.
- ~30-50 MB extra RSS (one extra Node process) for deliberate `count: 1` users.
- Debugger/inspector attaches to the worker; Node auto-increments cluster worker inspector ports.
- `run()` resolves in the primary after forking; primary-side closures are not shared with the app
  (already the case at count >= 2).
- Hot restarts (`restartWorkers()` / SIGHUP via plugin-signal-restart) now roll the single worker:
  replacement is forked before the old one drains — same `SO_REUSEPORT` constraint as multi-worker.
- Accepted costs (from issue #168): extra RSS; brief capacity dip without `SO_REUSEPORT`.

## Code changes

### `packages/worker-manager/src/orchestrator.ts`

1. `runPrimary()`: delete the `if (workerCount === 1)` branch — always call `startPrimary(workerCount)`.
2. Delete `startSingleWorkerPrimary()` (signal handlers, 3 health warnings, startup log) — the
   multi-worker path registers equivalent signal handlers and the warnings are moot once forking.
3. Delete `shutdownSingleWorker()` — `shutdownPrimary()` covers the full sequence (drain via
   shutdown coordinator, timeout failsafe, shutdown callbacks, plugin uninstall,
   `shutdown:complete`, dispose, exit code).
4. `restartWorkers()`: remove the `workerCount === 1` early return and its warning.

### `packages/plugin-signal-restart/src/index.ts`

5. Delete the single-worker branch in `handleSignal` (SIGTERM for external restart) — SIGHUP now
   reaches `restartWorkers()` at count 1.

### Dependencies

6. Bump plugin peerDependencies on `@goopil/clusterkit` to `^2.0.0` for all five plugins
   (`pnpm-workspace.yaml` catalog).

### Docs / release

7. `packages/worker-manager/README.md`: remove/rewrite the single-worker paragraphs (lines ~136,
   ~156); add a v2 migration note (count 1 now forks; isPrimary semantics; RSS/debugger notes).
8. Changeset: major on `@goopil/clusterkit` (2.0.0), minor on `@goopil/clusterkit-signal-restart`
   (SIGHUP at count 1 now triggers an in-process rolling restart instead of SIGTERM).

## Error handling

- Initial fork failure at count 1 is handled by the existing `RestartCoordinator` (exponential
  backoff, fork-failure accounting, EMFILE bailout) — newly applies at count 1.
- Shutdown: `shutdownPrimary()` drains the single worker (IPC shutdown → ACK → disconnect →
  SIGTERM → SIGKILL escalation, per `shutdown.timeoutMs`).
- SIGHUP stays a no-op in the primary (prevents terminal-hangup default behavior).
- No config changes: `count: 1` is already a valid positive integer in `validation.ts`.

## Testing

- Reuse the mocked `clusterModule` harness: parameterize the existing multi-worker suites to also
  run at `count: 1` (fork + online, heartbeat → health registry, RSS recycle, restart roll,
  crash → backoff, shutdown drain).
- Delete the single-worker-specific tests (no-fork startup, shutdownSingleWorker, warnings).
- Add explicit cases: count 1 forks exactly one worker; heartbeats flow and RSS recycle triggers
  at count 1; `restartWorkers()` replaces the single worker.
- Coverage floors in `vitest.config.ts` are never lowered; raise if measured margin exceeds ~2
  points.

## Non-goals

- No compatibility flag or env escape hatch (hard removal, per issue decision).
- No other API changes bundled into 2.0.
- No change to `workers.env`, `execArgv`, plugin lifecycle, or shutdown protocol semantics.
