---
"@goopil/clusterkit": minor
---

Fix hot-restart deadlock: bound the wait for the old worker's exit during restartWorkers() and drain it if the replacement dies before coming online.
