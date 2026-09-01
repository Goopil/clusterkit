---
"@goopil/clusterkit-file-watcher": patch
---
Cancel the pending `startDelayMs` timer on uninstall/shutdown, guard `startWatchers` against a post-cleanup start, and preserve (merge, not overwrite) the `.env` payload through debounce coalescing with a trailing flush after `minRestartIntervalMs` skips.
