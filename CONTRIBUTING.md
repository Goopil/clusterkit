# Contributing

Thank you for your interest in contributing! This document covers the workflow for reporting issues, proposing changes, and submitting pull requests.

## Prerequisites

- **Node.js** — see [`.nvmrc`](./.nvmrc) for the required version (`nvm use` or `fnm use`)
- **pnpm** — enabled via corepack (`corepack enable pnpm`)

## Getting started

```bash
git clone https://github.com/Goopil/clusterkit.git
cd clusterkit
corepack enable pnpm
pnpm install
pnpm build
```

## Repository layout

```
packages/
  worker-manager/          # @goopil/clusterkit — core library
  plugin-prometheus/       # @goopil/clusterkit-prometheus — Prometheus plugin
  plugin-container-sizing/ # @goopil/clusterkit-sizing — container sizing plugin
examples/
  express/             # Express example with integrated Prometheus
  fastify/             # Fastify example
  hono/                # Hono example
  koa/                 # Koa example
  nestjs-express/      # NestJS (Express adapter) example
  nestjs-fastify/      # NestJS (Fastify adapter) example
docker/                # Dockerfiles and startup scripts
```

## Development workflow

```bash
pnpm build                                    # build all packages
pnpm --filter @goopil/clusterkit test     # test worker-manager
pnpm --filter @goopil/clusterkit-prometheus test  # test plugin-prometheus
pnpm test                                     # run all package tests
pnpm test:coverage                            # tests with coverage report
pnpm dev                                      # watch mode (all packages)
```

### Linux tests (SO_REUSEPORT)

Some behaviour is Linux-only (e.g. SO_REUSEPORT kernel load balancing). The Docker harness runs tests on a real Linux kernel:

```bash
pnpm test:linux          # build image + run full test suite
docker compose run --rm test   # re-run without rebuilding
```

## Submitting changes

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

2. **Write tests** — all new behaviour must be covered by vitest tests in `packages/*/test/`.

3. **Keep commits focused** — one logical change per commit. Commit messages should use the conventional commits style:
   ```
   feat: add worker age recycling
   fix: correct circuit breaker window reset
   docs: update prometheus options table
   ```

4. **Run the full suite** before pushing:
   ```bash
   pnpm build && pnpm test
   ```

5. **Open a pull request** against `main`. Describe what you changed and why.

## Reporting issues

Please include:
- Node.js version (`node --version`)
- OS and kernel version
- A minimal reproduction (code snippet or repository link)
- Expected vs. actual behaviour

## Code conventions

- All source code, comments, and JSDoc must be written in **English**.
- `@goopil/clusterkit` has **no runtime dependencies** — only `devDependencies` and `peerDependencies`.
- TypeScript strict mode is enabled — no `any` without a justifying comment.
- Tests live in `packages/*/test/` and mirror their source module (e.g. `sizing.ts` → `test/sizing.test.ts`).
- Public API changes require an update to the root [README.md](./README.md).

## License

By contributing you agree that your contributions will be licensed under the [LGPL-3.0](./LICENSE).
