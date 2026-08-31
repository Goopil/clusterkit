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

1. **File watching** (`watch`): watches literal file/directory paths for changes. On change, triggers a debounced rolling restart.
2. **`.env` file watching** (`envFile`): watches `.env` files. On change, re-parses the file and passes the parsed env to `restartWorkers({ env })`.
3. **`process.env` polling** (`pollEnv`): snapshots `process.env` and polls for changes. On diff, triggers a restart with the full `process.env`.

## Watch paths are literal — no globs

The plugin uses **chokidar v4, which removed glob support**: paths in `watch` are matched **literally**. Pass a file or a directory, not a pattern like `src/**/*.ts`:

```js
createFileWatcherPlugin({
  watch: ["./src", "./config/app.toml"], // literal paths only
})
```

To exclude files inside a watched directory, use `ignore` — it is passed to chokidar's `ignored` option, which still accepts glob patterns.

## Watch out for the `add`-event restart loop

The plugin restarts on `change`, `add`, **and** `unlink` events. If you watch a directory your application writes into — logs, uploads, caches, tmp files — every new file emits an `add` event and triggers a restart, which may itself write more files and loop.

Watch only source/config paths and exclude runtime directories with `ignore`:

```js
createFileWatcherPlugin({
  watch: ["./src"],
  ignore: ["**/logs/**", "**/uploads/**", "**/*.tmp"],
})
```

## Single-worker mode

The plugin has no effect in single-worker mode (`workers: { count: 1 }`). A file change does not trigger a full process exit (that would be a crash loop on every save).

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `watch` | `string \| string[]` | `[]` | Literal paths (files or directories) to watch. No globs since chokidar v4. |
| `watchOptions` | `object` | `{}` | Options passed through to the watcher. |
| `ignore` | `string \| string[]` | `[]` | Patterns to ignore (chokidar's `ignored`, still supports globs). |
| `envFile` | `string \| string[]` | `[]` | Path(s) to `.env` files to parse on change. |
| `envParser` | `(content: string) => Record<string, string>` | `parseEnvFile` | Custom `.env` parser. |
| `pollEnv` | `boolean` | `false` | Enable `process.env` polling. |
| `pollEnvIntervalMs` | `number` | `5000` | Interval for `process.env` polling. |
| `debounceMs` | `number` | `300` | Debounce time for coalescing rapid changes. |
| `debounceMaxWaitMs` | `number` | `0` (off) | Max time since the first unflushed change before the restart fires anyway, even if changes keep arriving. |
| `minRestartIntervalMs` | `number` | `0` (off) | Minimum delay between actual restarts; triggers firing within the window after the last restart are skipped. |
| `staggerMs` | `number` | `1000` | Delay between draining worker N and starting worker N+1. |
| `reason` | `string` | `"file-change"` or `"env-change"` | Reason string for restart events. |
| `startDelayMs` | `number` | `0` | Delay before starting watchers. |
| `dryRun` | `boolean` | `false` | Log what would restart without actually restarting. |

## Restart storm hardening

By default, every change resets the debounce timer (trailing-edge debounce) and every debounced trigger restarts. Two optional guards protect against pathological change storms; both default to `0` (off).

### `debounceMaxWaitMs` — restart during continuous storms

If changes keep arriving faster than `debounceMs`, the restart is starved indefinitely. `debounceMaxWaitMs` caps the wait: the restart fires once this much time has elapsed since the **first unflushed change**, even while the storm continues:

```js
createFileWatcherPlugin({
  watch: ["./src"],
  debounceMs: 300,
  debounceMaxWaitMs: 2_000, // restart at most 2s after the first unflushed change
})
```

### `minRestartIntervalMs` — throttle back-to-back restarts

Caps the restart rate: a debounced trigger that would fire within this window after the last actual `restartWorkers` call is skipped (logged at debug level):

```js
createFileWatcherPlugin({
  watch: ["./src"],
  minRestartIntervalMs: 5_000, // at most one restart per 5s
})
```

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
