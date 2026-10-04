---
"@goopil/clusterkit": patch
---

Fix the prefixed logger passing an explicit `undefined` data argument to the underlying logger. Raw console methods
rendered that as a stray `undefined` after every message logged without fields (e.g. with `logger: console`).
