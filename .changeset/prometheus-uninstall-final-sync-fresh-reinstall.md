---
"@goopil/clusterkit-prometheus": patch
---

Finish the plugin lifecycle in `uninstall()`: the final `active_workers` sync and merged-metrics cache reset now run in
`uninstall()` instead of a `shutdown:complete` listener (which never fires anymore since `shutdown:complete` is emitted
after plugin uninstall). **Behavior change for plugin authors:** final work belongs in `uninstall()`, not in a
`shutdown:complete` listener. Also: uninstalling now removes the collected default process metrics from the registry and
resets the internal install latch, so reinstalling the plugin (e.g. after a teardown/rebuild cycle) collects default
metrics again instead of silently skipping them on a fresh registry.
