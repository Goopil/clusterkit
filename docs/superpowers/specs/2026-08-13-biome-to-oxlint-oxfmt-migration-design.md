# Migration: Biome → Oxlint + Oxfmt

**Date:** 2026-08-13
**Status:** Approved
**Scope:** Entire monorepo — all packages, examples, scripts, configs, CI

## 1. Objective

Replace Biome (linter + formatter) with Oxlint (linter) and Oxfmt (formatter) across the
entire repository in a single PR. The migration is a clean break: Biome is fully removed,
oxlint + oxfmt become the sole linting and formatting tools.

### Rationale

- Oxlint provides 845+ rules with native plugins (TypeScript, import, unicorn, vitest, etc.)
  and type-aware linting via tsgo (TypeScript 7 Go port).
- Oxfmt passes 100% of Prettier's JS/TS conformance tests, supports JSON/YAML/TOML/MD
  natively, and includes builtin import sorting, package.json sorting, and Tailwind class
  sorting — no external plugins needed.
- Both tools are written in Rust: 50–100x faster than ESLint, ~2x faster than Biome.
- Separation of lint and format concerns (Biome combined both in `biome check`).

### Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Strategy | Full replacement, single PR | Clean break; no transition period |
| Linter strictness | More strict than Biome | Activate correctness/suspicious rules Biome lacked |
| Severity model | Mixed warn/error | Style rules warn, correctness rules error |
| Formatter | Oxfmt (not Prettier) | Native Oxidation ecosystem, builtin import sorting |
| CI integration | Direct replacement | Same pipeline position, two commands instead of one |
| Scope | Entire repo (packages + examples + scripts) | Consistent linting everywhere |
| Import sorting | Oxfmt `sortImports` (perfectionist-based) | Replaces Biome's `organizeImports` |

## 2. Current Biome footprint

### Config

- `biome.json` at repo root (schema v2.5.7)
- Preset `recommended` with customizations:
  - `noUnusedImports: "warn"`, `noUnusedVariables: "warn"`
  - `noExplicitAny: "off"`, `noNonNullAssertion: "off"`
  - `useNodejsImportProtocol: "error"`
- Formatter: 2-space indent, 120 char line width, `organizeImports: "on"`
- Ignores inline in `files.includes`: `node_modules`, `dist`, `.turbo`, `coverage`,
  `.pnpm-store`, `pnpm-lock.yaml`, `.worktrees`

### Dependencies

- `@biomejs/biome@^2.5.7` in root `devDependencies` only (not in pnpm catalog)
- No sub-package declares Biome

### Scripts (root `package.json`)

- `lint`: `biome check .`
- `lint:fix`: `biome check --write .`
- `format`: `biome format --write .`

### CI

- `.github/workflows/ci.yml`, `lint` job: `pnpm biome check .` (first gate in pipeline)

### Other references

- `.github/PULL_REQUEST_TEMPLATE.md`: checklist item `pnpm biome check .` passes
- `AGENTS.md`: commands section + CI gate section reference `biome check .`
- `turbo.json`: no Biome task (Biome runs only from root, not via Turborepo)
- No `.biomeignore` file
- No `.editorconfig`, no `.prettierignore`, no `.eslintignore`
- CHANGELOGs and design specs reference Biome in prose (historical, not updated)

### Workspace layout

- 4 publishable packages: `@goopil/clusterkit`, `@goopil/clusterkit-prometheus`,
  `@goopil/clusterkit-sizing`, `@goopil/clusterkit-otlp-meter`
- 9 example apps: express, express-otlp, fastify, hono, koa, nestjs-express,
  nestjs-fastify, inertia-ssr, inertia-ssr-react
- No root `tsconfig.json`; each package/example has its own standalone tsconfig
- `.gitignore` covers: `node_modules`, `dist`, `.turbo`, `coverage`, `.pnpm-store`,
  `.worktrees`, `.superpowers`, `.idea`, `.junie`, `.DS_Store`

## 3. Configuration mapping

### 3.1 Linter: Biome → Oxlint

#### Category activation

| oxlint category | Severity | Description |
|---|---|---|
| `correctness` | `error` | Code that is definitely wrong or useless (default) |
| `suspicious` | `warn` | Code that is likely wrong or useless |
| `perf` | `warn` | Performance-improving rules |

#### Rule mapping

| Biome rule | Oxlint rule | Severity | Notes |
|---|---|---|---|
| `noUnusedImports: "warn"` | `eslint/no-unused-vars: ["warn", { "argsIgnorePattern": "^_" }]` | warn | Covers both unused imports and variables |
| `noUnusedVariables: "warn"` | (same as above) | warn | Single rule handles both |
| `noExplicitAny: "off"` | `typescript/no-explicit-any: "warn"` | warn | **Upgraded from off → warn** (more strict) |
| `noNonNullAssertion: "off"` | `typescript/no-non-null-assertion: "warn"` | warn | **Upgraded from off → warn** (more strict) |
| `useNodejsImportProtocol: "error"` | `unicorn/prefer-node-protocol: "error"` | error | Direct equivalent |

#### Additional rules (more strict than Biome)

| Oxlint rule | Severity | Rationale |
|---|---|---|
| `typescript/no-floating-promises` | error | Critical for Node.js async code |
| `typescript/no-misused-promises` | error | Detects async callbacks in non-async contexts |
| `typescript/consistent-type-imports` | warn | Forces `import type` when possible |
| `eslint/no-console` | warn | Avoid forgotten console.log in production code |
| `eslint/no-debugger` | error | No debugger statements in production |

#### Plugins

| Plugin | Enabled | CLI flag |
|---|---|---|
| `typescript` | yes (default) | — |
| `unicorn` | yes (default) | — |
| `oxc` | yes (default) | — |
| `import` | yes | `--import-plugin` |
| `vitest` | yes (for test files) | `--vitest-plugin` |

#### Overrides

| File pattern | Plugins | Rules relaxed |
|---|---|---|
| `**/test/**`, `**/*.test.ts` | `vitest` | `no-console: off`, env `vitest: true` |
| `examples/**` | — | `no-console: off` |
| `scripts/**` | — | `no-console: off` |

#### Environment

- `node: true`
- `es2022: true`

#### Type-aware linting

Not enabled initially. oxlint auto-discovers per-package `tsconfig.json` files, but there
is no root `tsconfig.json`. Activating `--type-aware` without a root tsconfig may cause
resolution issues. Can be enabled in a follow-up once a root tsconfig is added or
oxlint's per-package discovery is validated.

### 3.2 Formatter: Biome → Oxfmt

| Biome option | Oxfmt option | Value |
|---|---|---|
| `indentStyle: "space"` | `useTabs` | `false` (default) |
| `indentWidth: 2` | `tabWidth` | `2` (default) |
| `lineWidth: 120` | `printWidth` | `120` |
| `organizeImports: "on"` | `sortImports` | configured (see below) |
| (none) | `sortPackageJson` | `false` (disabled to avoid noisy diffs on package.json) |

#### Import sorting config

Based on `eslint-plugin-perfectionist/sort-imports` defaults:

```json
{
  "sortImports": {
    "groups": [
      "type-import",
      ["value-builtin", "value-external"],
      "type-internal",
      "value-internal",
      ["type-parent", "type-sibling", "type-index"],
      ["value-parent", "value-sibling", "value-index"],
      "unknown"
    ]
  }
}
```

### 3.3 Ignore patterns

Oxfmt reads `.gitignore` natively. Oxlint reads `.gitignore` and `.eslintignore`.

Additional ignores needed beyond `.gitignore`:

| Pattern | In .gitignore? | Why needed |
|---|---|---|
| `node_modules` | yes | — |
| `dist` | yes | — |
| `.turbo` | yes | — |
| `coverage` | yes | — |
| `.pnpm-store` | yes | — |
| `.worktrees` | yes | — |
| `.superpowers` | yes | — |
| `pnpm-lock.yaml` | **no** | Lockfile must not be reformatted |

`.oxlintignore` and `.oxfmtignore` files at root will contain `pnpm-lock.yaml` (the only
pattern not already in `.gitignore`).

## 4. New configuration files

### `.oxlintrc.json` (root)

```jsonc
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["typescript", "unicorn", "oxc", "import", "vitest"],
  "categories": {
    "correctness": "error",
    "suspicious": "warn",
    "perf": "warn"
  },
  "env": {
    "node": true,
    "es2022": true
  },
  "rules": {
    "eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
    "typescript/no-explicit-any": "warn",
    "typescript/no-non-null-assertion": "warn",
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/consistent-type-imports": ["warn", { "prefer": "type-imports" }],
    "unicorn/prefer-node-protocol": "error",
    "eslint/no-console": "warn",
    "eslint/no-debugger": "error"
  },
  "overrides": [
    {
      "files": ["**/test/**", "**/*.test.ts"],
      "plugins": ["vitest"],
      "env": { "vitest": true },
      "rules": {
        "eslint/no-console": "off"
      }
    },
    {
      "files": ["examples/**"],
      "rules": {
        "eslint/no-console": "off"
      }
    },
    {
      "files": ["scripts/**"],
      "rules": {
        "eslint/no-console": "off"
      }
    }
  ]
}
```

### `.oxfmtrc.json` (root)

```jsonc
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 120,
  "tabWidth": 2,
  "sortPackageJson": false,
  "sortImports": {
    "groups": [
      "type-import",
      ["value-builtin", "value-external"],
      "type-internal",
      "value-internal",
      ["type-parent", "type-sibling", "type-index"],
      ["value-parent", "value-sibling", "value-index"],
      "unknown"
    ]
  }
}
```

### `.oxlintignore` (root)

```
pnpm-lock.yaml
```

### `.oxfmtignore` (root)

```
pnpm-lock.yaml
```

## 5. Script changes (root `package.json`)

| Before | After |
|---|---|
| `"lint": "biome check ."` | `"lint": "oxlint"` |
| `"lint:fix": "biome check --write ."` | `"lint:fix": "oxlint --fix"` |
| `"format": "biome format --write ."` | `"format": "oxfmt --write"` |
| (none) | `"format:check": "oxfmt --check"` |

`format:check` is new — needed for CI to verify formatting without writing.

## 6. CI changes (`.github/workflows/ci.yml`)

The `lint` job replaces `pnpm biome check .` with two commands:

```yaml
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm oxlint
      - run: pnpm oxfmt --check
```

Pipeline position unchanged: lint remains the first gate.

## 7. Other file changes

| File | Action | Details |
|---|---|---|
| `biome.json` | Delete | No longer needed |
| `package.json` | Edit | Replace `@biomejs/biome` dep with `oxlint` + `oxfmt`; update scripts |
| `.github/workflows/ci.yml` | Edit | Replace `pnpm biome check .` with `pnpm oxlint` + `pnpm oxfmt --check` |
| `.github/PULL_REQUEST_TEMPLATE.md` | Edit | `pnpm biome check .` → `pnpm lint && pnpm format:check` |
| `AGENTS.md` | Edit | Update commands section + CI gate section |
| CHANGELOGs | No change | Historical references are factual |
| `docs/superpowers/specs/*.md` | No change | Historical references are factual |

## 8. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Oxfmt reformats differently from Biome on edge cases | Medium | Run `oxfmt --write` on entire repo in the same PR; diff is cleaned in one shot |
| New oxlint rules flag existing code | Medium | Run `oxlint --fix` first for auto-fixes; manually fix remaining; downgrade noisy rules to `warn` if needed |
| `unicorn/prefer-node-protocol` rule name mismatch | Low | Verify exact rule name before implementation; fallback to `import/no-nodejs-modules` or inline config |
| No root `tsconfig.json` → type-aware linting issues | Low | Type-aware linting not enabled initially; oxlint auto-discovers per-package tsconfigs |
| `sortPackageJson` reorders all package.json files | Medium | Set `sortPackageJson: false` in oxfmt config |
| Import sorting changes import order across all files | Medium | Oxfmt handles this in the format pass; diff is expected and clean |

## 9. Execution order

1. Install `oxlint` + `oxfmt` as devDependencies; remove `@biomejs/biome`
2. Create `.oxlintrc.json`, `.oxfmtrc.json`, `.oxlintignore`, `.oxfmtignore`
3. Update root `package.json` scripts
4. Run `oxlint --fix` to auto-fix lint issues
5. Manually fix remaining lint errors (or adjust rule severities)
6. Run `oxfmt --write` to reformat the entire repo
7. Update CI (`ci.yml`), PR template, `AGENTS.md`
8. Delete `biome.json`
9. Verify `pnpm build && pnpm test` pass
10. Add changeset
11. Commit all changes in a single commit

## 10. Verification

- `pnpm oxlint` exits 0 (no errors)
- `pnpm oxfmt --check` exits 0 (all files formatted)
- `pnpm build` succeeds (all packages build)
- `pnpm test` succeeds (all tests pass)
- No references to `biome` in executable config (CHANGELOGs and historical specs excepted)
