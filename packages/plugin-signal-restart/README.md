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

## Choosing a signal

The plugin warns at install time when the configured signal is likely to misbehave:

- **`SIGTERM` / `SIGINT`** are reserved for the orchestrator's graceful shutdown. Both handlers would fire on the same signal and race. Use a different signal (e.g. `SIGUSR2`).
- **`SIGHUP`** (the default) is also the terminal hangup signal. In a TTY (dev terminal / SSH session), closing the terminal triggers a fleet restart. Prefer `SIGUSR2` in dev/TTY environments; `SIGHUP` remains fine when managed by a process manager (systemd, Docker, etc.) that detaches the process from a terminal.
- **`SIGUSR2`** is also nodemon's restart signal — if nodemon runs in front of your app, it will react to the same signal. Avoid `SIGUSR2` behind nodemon and pick a signal not claimed by your other tooling.

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
