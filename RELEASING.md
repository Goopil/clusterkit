# Releasing

Releases are automated with [changesets](https://github.com/changesets/changesets)
and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC —
no npm token stored in the repo).

## Day-to-day flow (fully automated)

1. In any PR that changes a package, run:

   ```bash
   corepack pnpm changeset
   ```

   Pick the affected package(s), the bump type, and write a short summary.
   Commit the generated `.changeset/*.md` file with your PR.

2. When the PR merges to `main`, the [release workflow](.github/workflows/release.yml)
   opens (or updates) a **"chore(release): version packages"** PR containing the
   version bumps, CHANGELOG entries and the refreshed lockfile.

3. Merging that PR triggers the actual publish: full build + tests, then
   pnpm creates package tarballs in topological order (core before plugins,
   workspace protocol ranges rewritten to real semver), then npm publishes those
   tarballs through OIDC and pushes git tags (`@goopil/clusterkit@x.y.z`).

That's it — no manual npm command is ever needed after the bootstrap below.

## One-time bootstrap (first publish)

Trusted publishing is configured per package on npmjs.com, so the very first
version of each package is published manually:

```bash
# from a clean main, logged in to npm (2FA) with rights on the @goopil scope
corepack pnpm build && corepack pnpm test
corepack pnpm publish -r --tag next
```

> `--tag next` keeps the RC away from `latest` — `npm install @goopil/clusterkit`
> will not resolve to it by accident.

Then, for **each** of the three packages on npmjs.com
(`Settings → Publishing access → Trusted publisher`):

- Publisher: **GitHub Actions**
- Organization or user: `Goopil`
- Repository: `clusterkit`
- Workflow filename: `release.yml` (filename only, case-sensitive)
- Environment: leave empty

Also recommended on npmjs.com: require 2FA on the `@goopil` scope and set
publishing access to "Require two-factor authentication or automation".

> **Until this bootstrap is done**, pushes to `main` without pending changesets
> make the Release workflow attempt a publish and fail on npm authentication —
> that is expected and harmless. Once the RCs exist on the registry,
> The release script skips already-published versions, so the job goes green.

## Graduating the RC to stable

Current versions are `1.0.0-rc.1` (core) and `0.1.0-rc.1` (plugins). Once the
RC has been validated (examples running in Docker, ideally a real deployment):

```bash
corepack pnpm changeset       # select all three packages, bump type: patch
```

A `patch` bump on a prerelease graduates it (`1.0.0-rc.1` → `1.0.0`,
`0.1.0-rc.1` → `0.1.0`). Merge the resulting Version Packages PR: the workflow
publishes the stable versions to the default `latest` dist-tag.

If another RC round is needed instead, publish it manually with
`pnpm publish -r --tag next` after bumping to `-rc.2` by hand — the automated
pipeline is reserved for stable releases.

## Sanity checklist before any release

- CI green on `main` (lint, build, tests Node 22/24/26, Docker SO_REUSEPORT, publint)
- `corepack pnpm publish -r --dry-run` shows the expected files (dist/, LICENSE, README)
  and rewritten peer ranges
