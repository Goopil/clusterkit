---
"@goopil/clusterkit": patch
---

Harden worker env handling: reject prototype-pollution keys in every env path (validation, patchWorkerEnv, restart overlay) and warn when workers.env contains NODE_OPTIONS.
