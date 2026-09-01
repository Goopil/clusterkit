---
"@goopil/clusterkit": patch
---

`installPlugins` now isolates plugin failures: the error names the failing plugin and plugins already installed are rolled back (uninstalled) before `run()` rejects.
