---
"@goopil/clusterkit": patch
"@goopil/clusterkit-signal-restart": patch
"@goopil/clusterkit-file-watcher": patch
"@goopil/clusterkit-sizing": patch
---

Fix all 32 open SonarCloud issues: refactor validateConfig to reduce cognitive complexity, fix async signal handler, extract nested ternaries, use Set for dangerous keys, log caught exceptions in platform detection, parameterize duplicate tests, add missing test assertions, and prefer toHaveLength over toBe for array lengths.
