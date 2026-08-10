---
"@goopil/clusterkit": patch
"@goopil/clusterkit-sizing": patch
---

Core audit fixes: reject cgroup path traversal via `..` components,
deduplicate concurrent `detectReusePortSupport` calls, block dangerous
`execArgv` flags (`--require`, `--eval`, `--inspect`), fix Inertia SSR
example, deduplicate `withLoggerPrefix` across plugins, pin CI actions
to SHAs, run Docker containers as non-root.
