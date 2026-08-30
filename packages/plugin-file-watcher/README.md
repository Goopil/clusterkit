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
