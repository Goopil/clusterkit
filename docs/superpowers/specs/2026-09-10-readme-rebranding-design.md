# README rebranding — product ladder

Date: 2026-09-10
Status: approved (chat design + plan review)

## Problem

The root README opens on "Production-ready Node.js cluster orchestrator" and is structured as a
reference catalog (packages, config, API, events, internals). It reads like documentation, not like
a product someone can pick up. The user wants a product-oriented surface: a 5-minute getting
started, then progressive levels that ramp up capability by capability.

## Decisions

- **Scope**: root `README.md` + GitHub repository "About" description. Package READMEs stay as the
  technical reference.
- **Structure**: 4 progressive levels, plain text headers, no emoji, English only:
  1. `Getting started in 5 minutes` — install + full runnable snippet + what you just got
  2. `Level 1 — Ready to deploy` — worker count, health checks, shutdown budget
  3. `Level 2 — Observability` — Prometheus + OTLP teasers with links
  4. `Level 3 — Automation` — hot restart plugins, custom plugin teaser
- **Tagline**: `Multi-worker Node.js, made boring.` (deadpan register, no marketing adjectives),
  supported by one factual sentence describing what the orchestrator does.
- **Reference content** (worker count table, full configuration, API, events, graceful shutdown
  detail, circuit breaker, exit codes, security defaults note, plugin system section) moves out of
  the root README into `packages/worker-manager/README.md`, which becomes the single detailed
  reference. Plugin option/metrics tables already live in their own package READMEs; the root
  README keeps short teasers with links.
- **GitHub description**: factual, no emoji, no "production-ready".

## Non-goals

- No rewrite of the 6 package READMEs (beyond absorbing the moved reference into the core one).
- No content changes to examples, benchmarks, or development sections (kept as-is, re-ordered).
- No code changes, no changeset (docs only).

## Verification

- Relative links in both READMEs resolve.
- `corepack pnpm test:packages` (publint) — the core README ships in the npm tarball.
- Getting-started snippet derived from the existing Quick start, cross-checked against examples.
