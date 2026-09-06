---
"@goopil/clusterkit": minor
---

feat: expose `orchestrator.isPrimary` — `true` in the primary process (including single-worker mode, where the primary runs the app), `false` in forked workers. Plugin authors should gate primary-only resources (listeners, metrics endpoints) on this instead of importing `node:cluster` themselves.
