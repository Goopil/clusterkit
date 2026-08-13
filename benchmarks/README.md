# Benchmarks

Performance benchmark suite comparing `@goopil/clusterkit` against other Node.js process orchestrators.

## Quick start

```bash
# Install dependencies
corepack pnpm install

# Full benchmark suite (Docker, ~36 min, recommended for reference results)
corepack pnpm bench:docker

# Full benchmark suite (local, ~36 min)
corepack pnpm bench

# Quick mode (~8 min, single run per scenario)
corepack pnpm --filter benchmarks exec node runner.mjs --quick

# Smoke test (verify targets boot, no performance measurement)
corepack pnpm --filter benchmarks smoke

# List available targets and workloads
corepack pnpm --filter benchmarks exec node runner.mjs --list
```

## CLI flags

| Flag | Description | Default |
|------|-------------|---------|
| `--quick` | 3s warmup, 10s measure, 1 run per scenario | `false` (reference mode) |
| `--target <id>` | Run only one target (e.g. `clusterkit-3`) | all targets |
| `--workload <id>` | Run only one workload (e.g. `hello`) | all workloads |
| `--port <n>` | HTTP port for target servers | `3100` |
| `--list` | List available targets and workloads | — |
| `--smoke` | Smoke test: verify targets boot, no perf | `false` |
| `--conns-per-worker <n>` | Autocannon connections per worker | `50` |

## Targets

| ID | Description | Workers | SO_REUSEPORT |
|---|---|---|---|
| `single` | clusterkit with 1 worker (no fork) | 1 | N/A |
| `clusterkit-3` | clusterkit with 3 workers | 3 | Yes (Linux) |
| `native-cluster-3` | `cluster.fork` x3, Node.js round-robin | 3 | No |
| `throng-3` | throng(3) wrapper on cluster | 3 | No |
| `pm2-3` | pm2 cluster mode, 3 instances | 3 | No |
| `pm2-reload-3` | pm2 cluster + zero-downtime reload | 3 | No |

## Workloads

| ID | Description |
|---|---|
| `hello` | `res.json({hello, pid})` — pure orchestrator overhead |
| `latency-10ms` | `setTimeout(10ms)` — simulates async I/O |
| `cpu-io-mix` | 1ms CPU loop + 2ms setTimeout — realistic mix |
| `list-100` | Paginated list of 100 records (~5KB JSON) from 10k dataset — serialization stress |
| `aggregate` | Group-by + count + top-5 on 10k records — CPU-bound data processing |
| `auth-verify` | HMAC-SHA256 + JSON parse on every request — crypto overhead |
| `error-rate` | 10% of requests return structured 500 errors — error handling path |
| `upload-echo` | POST with ~1KB JSON body, validate + echo — body parsing overhead |

All workload responses include `pid: process.pid` for worker distribution validation.
The `upload-echo` workload uses POST method; the runner automatically sends a JSON body.

## Output

- **JSON**: `benchmarks/results/latest.json` — full raw data with per-run values
- **Markdown**: `BENCHMARKS.md` at repo root — summary tables for presentation

Commit both after a Docker reference run:
```bash
git add BENCHMARKS.md benchmarks/results/latest.json
```

## How to add a new target

1. Copy `targets/_template.mjs` to `targets/<your-target>.mjs`
2. The target is a standalone Node.js script. It reads `PORT` and `BENCH_WORKLOAD` from env:

```js
// The runner spawns this file via child_process.fork() with env:
//   PORT=3100 BENCH_WORKLOAD=hello
// Your script must start an HTTP server on PORT and handle SIGTERM for shutdown.

import { Orchestrator } from "@goopil/clusterkit";
import express from "express";

const workload = process.env.BENCH_WORKLOAD || "hello";
const port = Number.parseInt(process.env.PORT || "3100", 10);

// Load workload handler from ../workloads/<workload>.mjs
// Start your orchestrator + express app on PORT
// Handle SIGTERM to shut down gracefully (Orchestrator does this automatically)
```

3. Add the target ID to `ALL_TARGETS` and `EXPECTED_PIDS` in `runner.mjs` if the worker count differs from 3

## How to add a new workload

1. Create `workloads/<your-workload>.mjs`
2. Export a default express-style handler:

```js
export default function handler(req, res) {
  res.json({ hello: "world", pid: process.pid })
}
```

3. Add the workload ID to `ALL_WORKLOADS` in `runner.mjs`

## Architecture

```
benchmarks/
├── runner.mjs           # Main orchestrator: boot → warmup → measure → stop → report
├── workloads/           # Express handlers (hello, latency-10ms, cpu-io-mix)
├── targets/             # One .mjs per orchestrator (single, clusterkit-3, pm2-3, etc.)
├── lib/
│   ├── cli.mjs          # CLI flag parsing
│   ├── proc-sampler.mjs # /proc reader (RSS, CPU, PIDs)
│   ├── autocannon-runner.mjs  # Load generator wrapper
│   ├── pid-distributor.mjs    # Worker distribution checker
│   ├── pm2-launcher.mjs      # pm2 API wrapper
│   └── reporter.mjs           # JSON + Markdown generator
├── results/             # Output directory (latest.json)
├── Dockerfile.bench     # Docker image for Linux reference runs
└── docker-compose.override.yml  # Docker compose service
```

The sampler reads `/proc/[pid]/{status,stat}` from outside the target process tree — zero instrumentation of the SUT. This means benchmarks only work on Linux. On macOS, the harness runs but RSS/CPU metrics are unavailable.

## Reference vs quick mode

| | Reference | Quick |
|---|---|---|
| Warmup | 10s | 3s |
| Measure | 30s | 10s |
| Repetitions | 3 (median) | 1 |
| Total time | ~36 min | ~8 min |

Use quick mode during development. Use reference mode (Docker) for committable results.
