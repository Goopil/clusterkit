---
"@goopil/clusterkit": patch
---

Fix prototype pollution vulnerability in `patchWorkerEnv` by rejecting `__proto__`, `constructor`, and `prototype` keys before merging environment variables.
