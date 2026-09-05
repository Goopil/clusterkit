---
"@goopil/clusterkit-sizing": minor
---

feat: `compileCache` option — injects `NODE_COMPILE_CACHE` (env-only, never via `NODE_OPTIONS`) into the worker env to enable Node.js compile caching; `true` uses `<tmpdir>/clusterkit-compile-cache`, a string is used verbatim as the cache directory.
