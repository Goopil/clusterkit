---
"@goopil/clusterkit-prometheus": minor
---

fix: no longer collects default process metrics in the primary at count 1 (the forked worker reports them, as in multi-worker mode)
