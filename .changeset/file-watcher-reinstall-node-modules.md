---
"@goopil/clusterkit-file-watcher": patch
---

Fix plugin reinstall after uninstall/shutdown (watchers now re-arm instead of staying dead), ignore `node_modules` directories by default to prevent restart storms on package installs (`watchOptions.ignored` overrides entirely, `ignore` patterns merge with the default), and widen the chokidar peer range to `^4.0.0 || ^5.0.0`.
