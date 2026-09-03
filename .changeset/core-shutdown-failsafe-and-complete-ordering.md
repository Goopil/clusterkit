---
"@goopil/clusterkit": patch
---

Harden shutdown. **Behavior change for plugin authors:** `shutdown:complete` is now emitted **after** user shutdown
callbacks and plugin `uninstall()` in every mode — it used to fire before them in multi-worker mode, so a plugin's
`shutdown:complete` listener was already removed by its own `uninstall()` in single-worker mode and ran too early in
multi-worker mode. Plugins doing final work must do it in `uninstall()`. Also: the multi-worker primary now arms a
failsafe timer (`shutdown.timeoutMs`) around the callbacks + uninstall phase, force-exiting with code 1 if a callback
never resolves (single-worker mode and worker children already had this), and a recycled worker is drained even when
its replacement is forked but never comes online and never exits (boot hang) — within the same bounded budget as the
hot-restart exit wait.
