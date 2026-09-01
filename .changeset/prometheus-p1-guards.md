---
"@goopil/clusterkit-prometheus": patch
---
Guard `collectDefaultMetrics` against reinstall duplicates (single-worker reinstall with the same registry no longer rejects) and make `getMetrics()` fail fast with an explicit error when called outside the primary process.
