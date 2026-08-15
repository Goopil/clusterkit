# Hot-reload example

Demonstrates signal-based and file-watcher hot restart plugins working together with `@goopil/clusterkit`.

## What it shows

- **`createSignalRestartPlugin()`** — sends `SIGHUP` to trigger a rolling worker restart
- **`createFileWatcherPlugin()`** — watches `./src` and `./.env` for changes, triggers a debounced rolling restart on save
- **`createContainerSizingPlugin()`** — auto-detects CPU count from cgroup limits

## Setup

```bash
cd examples/hot-reload
pnpm install
pnpm build          # build all workspace dependencies
cp .env.example .env  # create .env from template (optional but recommended)
```

## Run

```bash
pnpm start
```

The server starts on port `3010` (override with `PORT=xxxx`).

```bash
curl http://localhost:3010
# → { "hello": "world", "pid": 12345, "restartKey": "initial" }
```

## Trigger a rolling restart

### Via signal (SIGHUP)

```bash
kill -HUP $(pgrep -f "node src/index.mjs" | head -1)
```

All workers are replaced one-by-one without dropping connections.

### Via file change

Edit any file under `./src` and save. The file watcher detects the change and triggers a debounced rolling restart after 300 ms.

### Via `.env` change

Edit `.env` and save. The file watcher re-parses the file and passes the new env to the replacement workers:

```bash
echo "APP_KEY=updated" > .env
# Next restart picks up the new APP_KEY value
```

## .env file

The `.env.example` template ships with `APP_KEY=initial`. Copy it to `.env` to exercise the env-watch mode. The `/` endpoint returns the current `APP_KEY` value so you can verify the rolling restart propagated the new environment.
