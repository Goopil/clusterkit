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
| `--scenario <id>` | Run a special scenario instead of the perf workloads (`recovery` is the only one today) | — (perf workloads) |
| `--health on\|off` | Recovery-scenario A/B seam: boot `clusterkit-3` with the opt-in health features | `off` |

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

## Recovery scenario

Measures crash recovery instead of throughput. The runner boots the target, waits 5 s, SIGKILLs half the workers,
then polls the HTTP endpoint every 100 ms — over a fresh connection each time, so the SO_REUSEPORT worker group is
actually sampled — until every worker slot answers again (10 s deadline).

```bash
# baseline (health features off — the default)
docker compose -f benchmarks/docker-compose.bench.yml run --build --rm benchmark --scenario recovery --quick

# features-on delta (A/B via the --health seam)
docker compose -f benchmarks/docker-compose.bench.yml run --build --rm benchmark --scenario recovery --quick --target clusterkit-3 --health on
```

With `--health on` the runner sets `BENCH_HEALTH=1` for the `clusterkit-3` target, which opts its Orchestrator into
the health features: `workers.maxRssMb: 512` and `health: { heartbeatMs: 500, wedgedTimeoutMs: 3000,
degradedAfterMs: 2000 }`. Without the flag the target boots exactly as on `main` — the features are opt-in and
default-off — so the features-off run doubles as the pre-branch baseline.

Metrics (written to `results/latest.json` and `results/REPORT.generated.md`):

- `restoreDurationMs` — from the SIGKILLs to the moment all worker slots answer again
- `bootTimesMs` — per-replacement time offsets, measured from the first replacement observed
- `requestsDuringRecovery` — successful requests served while capacity was degraded

Linux only: worker pids come from `/proc/<pid>/task/<pid>/children`, so on macOS the runner exits with a clear
error before booting anything. Defaults: target `clusterkit-3`, workload `hello` (any workload exposing `pid` works).

## Output

- **JSON**: `benchmarks/results/latest.json` — full raw data with per-run values
- **Markdown**: `benchmarks/results/REPORT.generated.md` — auto-generated tables (all workloads/targets found)
- **`BENCHMARKS.md`** at the repo root is hand-maintained (Key Findings prose) — the reporter never writes to it

Commit both generated files after a Docker reference run:
```bash
git add benchmarks/results/latest.json benchmarks/results/REPORT.generated.md
```

## How to add a new target

1. Create `targets/<your-target>.mjs` (any existing target, e.g. `clusterkit-3.mjs`, works as a starting point)
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
│   ├── recovery-runner.mjs    # Recovery scenario (SIGKILL half the workers, measure restore)
│   ├── pm2-launcher.mjs      # pm2 API wrapper
│   └── reporter.mjs           # JSON + Markdown generator
├── results/             # Output directory (latest.json, REPORT.generated.md)
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
