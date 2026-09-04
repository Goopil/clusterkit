# ADR 0001: Exact semantics of `registerOnShutdown`

- **Status:** Accepted
- **Date:** 2026-09 (documenting the Phase 0 decision, merged in PR #107)
- **Deciders:** clusterkit maintainers

## Context

The orchestrator exposes `registerOnShutdown(cb)` so the host application and
plugins can run cleanup work (flushing metrics, closing exporters, etc.) when
the orchestrator shuts down. Its behavior differs by process role — primary
with a fleet, single-worker mode, and worker processes — and the exact ordering
relative to worker drain and plugin uninstall was undocumented.

## Decision

Callbacks registered via `registerOnShutdown(cb)` run exactly once per process
during shutdown, as follows (see `shutdownPrimary()` and
`runShutdownCallbacks()` in `packages/worker-manager/src/orchestrator.ts`):

### Primary mode (multi-worker fleet)

In `shutdownPrimary()`, callbacks run in this order:

1. The shutdown latch is checked first: if a shutdown is already in progress
   (`isShutdownInProgress()`), `shutdownPrimary()` returns immediately, so
   callbacks cannot re-enter.
2. Signal handlers are unregistered, readiness flips to `false`, and
   `initiateShutdown()` drains the fleet (shutdown message + ACK wait, exit
   wait, SIGTERM → SIGINT → SIGKILL escalation for survivors).
3. **After** all workers are drained/terminated, `runShutdownCallbacks(signal)`
   runs each registered callback sequentially in registration order, awaiting
   each before starting the next.
4. Only then `uninstallPlugins()` runs, followed by worker-manager disposal and
   exit.

Error isolation: each callback is awaited inside its own `try`/`catch`. A
throwing callback is logged ("Shutdown callback failed") and **later callbacks
still run** — a failing callback can neither break the drain chain (drain has
already completed) nor skip the remaining callbacks or plugin uninstall.

### Single-worker mode

`shutdownSingleWorker()` runs callbacks in the primary process from the signal
handler (SIGTERM/SIGINT), after handlers are unregistered and under the forced
exit timer — before `uninstallPlugins()` and process exit.

### Worker mode

Each worker process runs its own copy of the orchestrator. In `startWorker()`,
the worker-side `handleShutdown` runs callbacks on POSIX SIGTERM/SIGINT and on
the primary's IPC shutdown message (whichever arrives first; the
`localShutdownInProgress` guard prevents double execution), inside the forced
exit timer window, before the worker exits.

## Consequences

- App/plugin flushes (e.g. the OTLP meter plugin) run on the primary **only in
  the post-drain window**: when they run, no worker is alive, so aggregated
  state is final. The flip side is that flushing cannot happen "early" to
  overlap with the drain.
- Callbacks always run **before** `uninstallPlugins()`, so plugins are still
  installed and can service the orchestrator while app callbacks run.
- Plugin `uninstall()` must be idempotent: uninstall is
  invoked from `shutdownPrimary()` and from install-rollback paths, and
  `uninstallPlugins()` swallows per-plugin errors, so a non-idempotent
  uninstall would silently corrupt cleanup.
- No ordering guarantee exists between callbacks other than registration
  order; do not rely on callbacks registered later by plugins running first.
- A callback that never resolves still blocks the shutdown path (the forced
  exit timer is the only backstop). Keep callbacks bounded.

## Alternatives considered

- **Run callbacks before the drain** — rejected: callbacks would flush while
  workers are still running and could outlive workers mid-drain (flush too
  early, state not final).
- **Run callbacks inside `uninstallPlugins()`** — rejected: uninstall is plugin
  bookkeeping, not application cleanup; conflating the two would make plugin
  uninstall behavior depend on application callbacks.
