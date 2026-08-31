---
"@goopil/clusterkit-file-watcher": minor
---

Add `debounceMaxWaitMs` (fire during continuous change storms) and `minRestartIntervalMs` (throttle back-to-back restarts), both defaulting to off. Correct docs: chokidar v4 paths are literal (no globs); document the watch-directory write-back footgun.
