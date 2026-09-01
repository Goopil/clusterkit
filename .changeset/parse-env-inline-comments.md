---
"@goopil/clusterkit-file-watcher": patch
---

Harden `parseEnvFile`: strip inline comments (` # ...`) from unquoted values while preserving them inside quotes, and skip prototype-pollution keys (`__proto__`, `constructor`, `prototype`) instead of setting them on the parsed object.
