---
"@goopil/clusterkit": patch
"@goopil/clusterkit-prometheus": patch
"@goopil/clusterkit-sizing": patch
---

Audit fixes: reject cgroup path traversal, deduplicate concurrent detectReusePortSupport calls, block dangerous execArgv flags (--require, --eval, --inspect), fix Inertia SSR example, use shared withLoggerPrefix, add /metrics endpoint to express example, pin CI actions to SHAs, run Docker containers as non-root.
