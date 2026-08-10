---
"clusterkit": patch
---

Fix axios security advisory (GHSA) by adding a `pnpm.overrides` entry forcing
`axios >= 1.18.0`. axios was only pulled in as an optional peer dependency of
`@inertiajs/core` and `laravel-precognition` in the Inertia SSR examples; the
override ensures no vulnerable version can be resolved and the lockfile no
longer resolves axios 1.16.0.
