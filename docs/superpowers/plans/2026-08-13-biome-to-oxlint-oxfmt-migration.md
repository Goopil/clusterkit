# Biome → Oxlint + Oxfmt Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Biome with Oxlint (linter) and Oxfmt (formatter) across the entire monorepo in a single PR.

**Architecture:** Install oxlint + oxfmt as root devDependencies. Create `.oxlintrc.json` and `.oxfmtrc.json` at repo root with centralized config. Run auto-fix + reformat across the whole repo. Update CI, PR template, and AGENTS.md. Delete Biome config.

**Tech Stack:** oxlint (1.78.0), oxfmt (0.63.0), pnpm 10.30.1, Node 22+

## Global Constraints

- Use `corepack pnpm`, not bare `pnpm`.
- Node `>=22.12.0` (see `.nvmrc`); always `source ~/.nvm/nvm.sh && nvm use` before any command.
- Keep all source code, comments, tests, and docs in English.
- Do not add runtime dependencies to `@goopil/clusterkit` — only devDependencies.
- Work in the worktree at `.worktrees/feat-oxlint-oxfmt-migration/`.
- Every commit must be in the worktree, not the main checkout.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `.oxlintrc.json` | Create | Linter configuration: plugins, categories, rules, overrides |
| `.oxfmtrc.json` | Create | Formatter configuration: print width, indent, import sorting |
| `.oxlintignore` | Create | Linter ignore patterns (pnpm-lock.yaml) |
| `.oxfmtignore` | Create | Formatter ignore patterns (pnpm-lock.yaml) |
| `package.json` | Modify | Replace biome scripts + dependency with oxlint + oxfmt |
| `biome.json` | Delete | No longer needed |
| `.github/workflows/ci.yml` | Modify | Replace `pnpm biome check .` with `pnpm oxlint` + `pnpm oxfmt --check` |
| `.github/PULL_REQUEST_TEMPLATE.md` | Modify | Update checklist item from biome to oxlint + oxfmt |
| `AGENTS.md` | Modify | Update commands section + CI gate section |

---

### Task 1: Install oxlint + oxfmt, remove @biomejs/biome

**Files:**
- Modify: `package.json` (devDependencies + scripts)

**Interfaces:**
- Produces: `oxlint` and `oxfmt` binaries available in `node_modules/.bin/`, `package.json` updated with new devDependencies and scripts

- [ ] **Step 1: Load nvm and switch to project Node version**

Run:
```bash
source ~/.nvm/nvm.sh && nvm use
```
Expected: "Now using node v22.18.0" (or similar 22+)

- [ ] **Step 2: Remove @biomejs/biome from devDependencies**

Run:
```bash
corepack pnpm remove @biomejs/biome
```
Expected: `package.json` no longer contains `@biomejs/biome`, `pnpm-lock.yaml` updated

- [ ] **Step 3: Install oxlint and oxfmt as devDependencies**

Run:
```bash
corepack pnpm add -D oxlint oxfmt
```
Expected: `package.json` now contains `"oxlint"` and `"oxfmt"` in `devDependencies`, `pnpm-lock.yaml` updated

- [ ] **Step 4: Update npm scripts in package.json**

Edit `package.json` scripts section. Replace these three lines:
```json
"lint": "biome check .",
"lint:fix": "biome check --write .",
"format": "biome format --write .",
```
With:
```json
"lint": "oxlint",
"lint:fix": "oxlint --fix",
"format": "oxfmt --write",
"format:check": "oxfmt --check",
```

- [ ] **Step 5: Verify the binaries are available**

Run:
```bash
corepack pnpm exec oxlint --version && corepack pnpm exec oxfmt --version
```
Expected: Both print version numbers (oxlint ~1.78.0, oxfmt ~0.63.0)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: replace @biomejs/biome with oxlint + oxfmt"
```

---

### Task 2: Create oxlint configuration files

**Files:**
- Create: `.oxlintrc.json`
- Create: `.oxlintignore`

**Interfaces:**
- Produces: `.oxlintrc.json` with plugins, categories, rules, and overrides; `.oxlintignore` with `pnpm-lock.yaml`

- [ ] **Step 1: Create `.oxlintrc.json`**

Write the following content to `.oxlintrc.json` at the repo root:

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

- [ ] **Step 2: Create `.oxlintignore`**

Write the following content to `.oxlintignore` at the repo root:

```
pnpm-lock.yaml
```

- [ ] **Step 3: Verify oxlint runs with the config**

Run:
```bash
corepack pnpm exec oxlint --print-config
```
Expected: Config is printed without errors (some lint warnings/errors on code are expected at this stage)

- [ ] **Step 4: Commit**

```bash
git add .oxlintrc.json .oxlintignore
git commit -m "chore: add oxlint configuration"
```

---

### Task 3: Create oxfmt configuration files

**Files:**
- Create: `.oxfmtrc.json`
- Create: `.oxfmtignore`

**Interfaces:**
- Produces: `.oxfmtrc.json` with printWidth, tabWidth, sortImports, sortPackageJson; `.oxfmtignore` with `pnpm-lock.yaml`

- [ ] **Step 1: Create `.oxfmtrc.json`**

Write the following content to `.oxfmtrc.json` at the repo root:

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

- [ ] **Step 2: Create `.oxfmtignore`**

Write the following content to `.oxfmtignore` at the repo root:

```
pnpm-lock.yaml
```

- [ ] **Step 3: Verify oxfmt runs with the config**

Run:
```bash
corepack pnpm exec oxfmt --check --no-error-on-unmatched-pattern . 2>&1 | tail -5
```
Expected: Runs without config errors (formatting differences are expected at this stage)

- [ ] **Step 4: Commit**

```bash
git add .oxfmtrc.json .oxfmtignore
git commit -m "chore: add oxfmt configuration"
```

---

### Task 4: Run oxlint --fix and fix remaining lint errors

**Files:**
- Modify: various `.ts`/`.mjs` files across `packages/`, `examples/`, `scripts/` (auto-fixable + manual fixes)

**Interfaces:**
- Consumes: `.oxlintrc.json` from Task 2
- Produces: All source files pass `oxlint` with zero errors

- [ ] **Step 1: Run oxlint --fix to auto-fix what can be fixed**

Run:
```bash
corepack pnpm exec oxlint --fix
```
Expected: Some files are auto-fixed (unused imports removed, import type added, etc.)

- [ ] **Step 2: Run oxlint to see remaining errors**

Run:
```bash
corepack pnpm exec oxlint 2>&1 | head -80
```
Expected: List of remaining lint errors/warnings that could not be auto-fixed

- [ ] **Step 3: Fix remaining errors manually**

For each error reported:
- If it's a `typescript/no-explicit-any` or `typescript/no-non-null-assertion` warning: these are `warn` severity, they won't block CI. Move on.
- If it's a `typescript/no-floating-promises` error: add `await` or `.catch()` to the floating promise.
- If it's a `typescript/no-misused-promises` error: fix the async callback signature.
- If it's a `unicorn/prefer-node-protocol` error: add `node:` prefix to the import (e.g., `import { join } from 'path'` → `import { join } from 'node:path'`).
- If a rule produces too many false positives on existing code, downgrade it to `"warn"` in `.oxlintrc.json`.

- [ ] **Step 4: Run oxlint again to verify zero errors**

Run:
```bash
corepack pnpm exec oxlint --deny-warnings 2>&1 | tail -20
```
Expected: Zero errors. Warnings are acceptable (no-explicit-any, no-non-null-assertion, no-console are warn-level).

If `--deny-warnings` fails, remove that flag and just verify exit code 0 without it:
```bash
corepack pnpm exec oxlint; echo "Exit code: $?"
```
Expected: Exit code 0 (warnings don't cause non-zero exit by default)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: resolve lint errors for oxlint migration"
```

---

### Task 5: Run oxfmt --write to reformat the entire repo

**Files:**
- Modify: all `.ts`, `.mjs`, `.js`, `.json`, `.md`, `.yml`, `.yaml` files across the repo

**Interfaces:**
- Consumes: `.oxfmtrc.json` from Task 3
- Produces: All files formatted according to oxfmt config (120 char width, 2-space indent, import sorting)

- [ ] **Step 1: Run oxfmt --write on the entire repo**

Run:
```bash
corepack pnpm exec oxfmt --write .
```
Expected: Many files reformatted (line width, import order, trailing commas, etc.)

- [ ] **Step 2: Verify formatting passes with --check**

Run:
```bash
corepack pnpm exec oxfmt --check .
```
Expected: Exit code 0, all files pass formatting check

- [ ] **Step 3: Review the diff for unexpected changes**

Run:
```bash
git diff --stat | tail -20
```
Expected: Modified files across packages and examples. No modifications to `pnpm-lock.yaml` (should be in `.oxfmtignore`). No modifications to `dist/` or `node_modules/` (should be in `.gitignore`).

If `pnpm-lock.yaml` was modified, check `.oxfmtignore` is correct and re-run.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "style: reformat repo with oxfmt"
```

---

### Task 6: Update CI, PR template, and AGENTS.md

**Files:**
- Modify: `.github/workflows/ci.yml` (lines 28)
- Modify: `.github/PULL_REQUEST_TEMPLATE.md` (line 17)
- Modify: `AGENTS.md` (lines 104-106, 141)

**Interfaces:**
- Consumes: new script names from Task 1
- Produces: CI runs `pnpm oxlint` + `pnpm oxfmt --check`; PR template references correct commands; AGENTS.md documents new tooling

- [ ] **Step 1: Update `.github/workflows/ci.yml`**

In the `lint` job (around line 28), replace:
```yaml
      - run: pnpm biome check .
```
With:
```yaml
      - run: pnpm oxlint
      - run: pnpm oxfmt --check
```

- [ ] **Step 2: Update `.github/PULL_REQUEST_TEMPLATE.md`**

Replace line 17:
```markdown
- [ ] `pnpm biome check .` passes
```
With:
```markdown
- [ ] `pnpm lint && pnpm format:check` passes
```

- [ ] **Step 3: Update `AGENTS.md` commands section**

Replace lines 104-106:
```markdown
corepack pnpm lint                   # biome check .
corepack pnpm lint:fix              # biome check --write .
corepack pnpm format                 # biome format --write .
```
With:
```markdown
corepack pnpm lint                   # oxlint
corepack pnpm lint:fix              # oxlint --fix
corepack pnpm format                 # oxfmt --write .
corepack pnpm format:check          # oxfmt --check (CI uses this)
```

- [ ] **Step 4: Update `AGENTS.md` CI gate section**

Replace line 141:
```markdown
1. **Lint** — `pnpm biome check .`
```
With:
```markdown
1. **Lint** — `pnpm oxlint && pnpm oxfmt --check`
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/PULL_REQUEST_TEMPLATE.md AGENTS.md
git commit -m "docs: update CI and docs for oxlint + oxfmt"
```

---

### Task 7: Delete biome.json and verify build + tests

**Files:**
- Delete: `biome.json`

**Interfaces:**
- Consumes: all previous tasks
- Produces: Biome fully removed, oxlint + oxfmt fully operational, build + tests pass

- [ ] **Step 1: Delete biome.json**

Run:
```bash
rm biome.json
```

- [ ] **Step 2: Run oxlint to verify it passes**

Run:
```bash
corepack pnpm oxlint; echo "Exit code: $?"
```
Expected: Exit code 0

- [ ] **Step 3: Run oxfmt --check to verify formatting**

Run:
```bash
corepack pnpm oxfmt --check .; echo "Exit code: $?"
```
Expected: Exit code 0

- [ ] **Step 4: Run build**

Run:
```bash
corepack pnpm build
```
Expected: All packages build successfully (tsdown, dual ESM+CJS)

- [ ] **Step 5: Run tests**

Run:
```bash
corepack pnpm test
```
Expected: All package tests pass (vitest)

- [ ] **Step 6: Commit the deletion**

```bash
git add -A
git commit -m "chore: remove biome.json, complete migration to oxlint + oxfmt"
```

- [ ] **Step 7: Verify no stale biome references in executable config**

Run:
```bash
grep -ri "biome" --include="*.json" --include="*.yml" --include="*.yaml" --include="*.mjs" --include="*.ts" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.turbo --exclude-dir=.git . | grep -v CHANGELOG | grep -v "docs/superpowers"
```
Expected: No results (or only historical references in CHANGELOGs and design specs)

- [ ] **Step 8: Final commit if any cleanup needed**

If step 7 found references in executable files, fix them and:
```bash
git add -A
git commit -m "chore: clean up remaining biome references"
```
If nothing was found, skip this step.

---

### Task 8: Add changeset

**Files:**
- Create: `.changeset/*.md` (generated by changeset CLI)

**Interfaces:**
- Produces: A changeset documenting the tooling change

- [ ] **Step 1: Create a changeset**

Run:
```bash
corepack pnpm changeset
```

Select:
- **@goopil/clusterkit** — patch
- Summary: "Migrate linter/formatter from Biome to Oxlint + Oxfmt"

Repeat for each publishable package if prompted:
- `@goopil/clusterkit-prometheus` — patch
- `@goopil/clusterkit-sizing` — patch
- `@goopil/clusterkit-otlp-meter` — patch

Each with the same summary.

- [ ] **Step 2: Verify changeset was created**

Run:
```bash
ls .changeset/*.md
```
Expected: A new `.changeset/*.md` file exists alongside `.changeset/README.md`

- [ ] **Step 3: Commit the changeset**

```bash
git add .changeset/
git commit -m "chore: add changeset for biome → oxlint migration"
```
