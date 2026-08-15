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
