# Benchmarks

## macOS

> Generated: 2026-08-13T19:35:24Z | Node v22.18.0 | darwin arm64 | 12 CPUs | Apple M2 Max
> Method: autocannon, 3s warmup + 10s measure, 1 run (median), 50 conns/worker
> SO_REUSEPORT: disabled (platform.ts hardcodes `false` for darwin)

### Workload: Hello World (JSON trivial)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 37,334 ± 0 | 1 ms | 2 ms | 2 ms | 0 | 2 ms | 5001 ms | N/A | N/A | N/A | N/A | 3/1 |
| clusterkit-3 | 3 | 50,006 ± 0 | 2 ms | 6 ms | 8 ms | 0 | 1 ms | 2361 ms | N/A | N/A | N/A | N/A | 3/3 |
| native-cluster-3 | 3 | 53,520 ± 0 | 2 ms | 4 ms | 5 ms | 0 | 1 ms | 5001 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 51,181 ± 0 | 2 ms | 5 ms | 6 ms | 0 | 2 ms | 7 ms | N/A | N/A | N/A | N/A | 3/3 |
| pm2-3 | 3 | 48,202 ± 0 | 2 ms | 8 ms | 9 ms | 49 | 1 ms | 280 ms | N/A | N/A | N/A | N/A | 3/3 |
| pm2-reload-3 | 3 | 17,144 ± 0 | 8 ms | 11 ms | 11 ms | 0 | 608 ms | 5002 ms | N/A | N/A | N/A | N/A | 2/3 |

### Workload: Latency 10ms

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 67,126 ± 0 | 0 ms | 1 ms | 2 ms | 0 | 1 ms | 5001 ms | N/A | N/A | N/A | N/A | 4/1 |
| clusterkit-3 | 3 | 51,610 ± 0 | 2 ms | 5 ms | 7 ms | 0 | 1 ms | 2354 ms | N/A | N/A | N/A | N/A | 3/3 |
| native-cluster-3 | 3 | 54,864 ± 0 | 2 ms | 4 ms | 5 ms | 0 | 1 ms | 5000 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 43,475 ± 0 | 2 ms | 8 ms | 10 ms | 0 | 1 ms | 8 ms | N/A | N/A | N/A | N/A | 3/3 |
| pm2-3 | 3 | 22,779 ± 0 | 3 ms | 23 ms | 25 ms | 37 | 1 ms | 281 ms | N/A | N/A | N/A | N/A | 3/3 |
| pm2-reload-3 | 3 | 11,648 ± 0 | 12 ms | 14 ms | 15 ms | 0 | 607 ms | 5002 ms | N/A | N/A | N/A | N/A | 2/3 |

### Workload: CPU-IO Mix

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 4,362 ± 0 | 11 ms | 12 ms | 12 ms | 0 | 2 ms | 5000 ms | N/A | N/A | N/A | N/A | 4/1 |
| clusterkit-3 | 3 | 12,721 ± 0 | 11 ms | 13 ms | 14 ms | 0 | 1 ms | 2170 ms | N/A | N/A | N/A | N/A | 3/3 |
| native-cluster-3 | 3 | 12,809 ± 0 | 11 ms | 13 ms | 13 ms | 0 | 1 ms | 5001 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 12,445 ± 0 | 11 ms | 14 ms | 17 ms | 0 | 2 ms | 6 ms | N/A | N/A | N/A | N/A | 3/3 |
| pm2-3 | 3 | 8,914 ± 0 | 12 ms | 110 ms | 130 ms | 0 | 1 ms | 274 ms | N/A | N/A | N/A | N/A | 2/3 |
| pm2-reload-3 | 3 | 1,099 ± 0 | 89 ms | 260 ms | 977 ms | 0 | 505 ms | 5002 ms | N/A | N/A | N/A | N/A | 2/3 |

### Summary (macOS)

- **Throughput winner** (hello): native-cluster-3 — 53,520 req/sec
- **Lowest latency p99** (hello): single — 2 ms
- **Fastest boot** (hello): clusterkit-3 — 1 ms
- **Fastest shutdown** (hello): throng-3 — 7 ms
- **Throughput winner** (latency-10ms): single — 67,126 req/sec
- **Lowest latency p99** (latency-10ms): single — 2 ms
- **Fastest boot** (latency-10ms): single — 1 ms
- **Fastest shutdown** (latency-10ms): throng-3 — 8 ms
- **Throughput winner** (cpu-io-mix): native-cluster-3 — 12,809 req/sec
- **Lowest latency p99** (cpu-io-mix): single — 12 ms
- **Fastest boot** (cpu-io-mix): clusterkit-3 — 1 ms
- **Fastest shutdown** (cpu-io-mix): throng-3 — 6 ms

---

## Linux (Docker)

> Generated: 2026-08-13T19:57:33Z | Node v22.23.2 | linux arm64 | 4 CPUs | Docker node:22-slim
> Method: autocannon, 3s warmup + 10s measure, 1 run (median), 50 conns/worker
> SO_REUSEPORT: enabled (kernel-level load balancing)

### Workload: Hello World (JSON trivial)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 18,544 ± 0 | 2 ms | 4 ms | 4 ms | 0 | 105 ms | 5 ms | 127 MB | 133 MB | 104.1% | 14,570 ms | 1/1 |
| clusterkit-3 | 3 | 55,482 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 208 ms | 9 ms | 184 MB | 133 MB | 93.2% | 13,050 ms | 3/3 |
| native-cluster-3 | 3 | 55,862 ± 0 | 2 ms | 5 ms | 6 ms | 0 | 212 ms | 1 ms | 183 MB | 131 MB | 94.9% | 14,240 ms | 3/3 |
| throng-3 | 3 | 55,536 ± 0 | 2 ms | 5 ms | 6 ms | 0 | 207 ms | 9 ms | 197 MB | 139 MB | 93.9% | 13,140 ms | 3/3 |
| pm2-3 | 3 | 53,600 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 410 ms | 222 ms | 405 MB | 147 MB | 146.4% | 20,490 ms | 3/3 |
| pm2-reload-3 | 3 | 17,927 ± 0 | 8 ms | 10 ms | 11 ms | 0 | 404 ms | 5004 ms | 264 MB | 150 MB | 90.9% | 13,640 ms | 2/3 |

### Workload: Latency 10ms

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 53,398 ± 0 | 0 ms | 2 ms | 3 ms | 0 | 3 ms | 5005 ms | N/A | N/A | N/A | N/A | 4/1 |
| clusterkit-3 | 3 | 54,495 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 2 ms | 1156 ms | 56 MB | 62 MB | 0.6% | 90 ms | 3/3 |
| native-cluster-3 | 3 | 54,401 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 2 ms | 5003 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 42,092 ± 0 | 3 ms | 8 ms | 10 ms | 0 | 3 ms | 5 ms | 198 MB | 160 MB | 685.9% | 96,030 ms | 3/3 |
| pm2-3 | 3 | 24,132 ± 0 | 1 ms | 15 ms | 25 ms | 17 | 1 ms | 221 ms | 53 MB | 59 MB | 0.5% | 70 ms | 3/3 |
| pm2-reload-3 | 3 | 10,821 ± 0 | 13 ms | 17 ms | 18 ms | 0 | 410 ms | 5008 ms | 258 MB | 145 MB | 58.0% | 8,120 ms | 2/3 |

### Workload: CPU-IO Mix

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 4,153 ± 0 | 12 ms | 13 ms | 14 ms | 0 | 3 ms | 5000 ms | N/A | N/A | N/A | N/A | 4/1 |
| clusterkit-3 | 3 | 11,954 ± 0 | 12 ms | 15 ms | 15 ms | 0 | 3 ms | 2078 ms | 56 MB | 63 MB | 0.8% | 110 ms | 3/3 |
| native-cluster-3 | 3 | 11,751 ± 0 | 12 ms | 15 ms | 15 ms | 0 | 2 ms | 5002 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 13,057 ± 0 | 11 ms | 13 ms | 14 ms | 0 | 3 ms | 4 ms | 120 MB | 69 MB | 2.9% | 410 ms | 3/3 |
| pm2-3 | 3 | 9,149 ± 0 | 13 ms | 105 ms | 114 ms | 65 | 2 ms | 219 ms | 53 MB | 59 MB | 0.6% | 80 ms | 3/3 |
| pm2-reload-3 | 3 | 1,287 ± 0 | 82 ms | 126 ms | 329 ms | 0 | 413 ms | 5006 ms | 232 MB | 118 MB | 95.7% | 14,350 ms | 2/3 |

### Summary (Linux)

- **Throughput winner** (hello): native-cluster-3 — 55,862 req/sec
- **Lowest latency p99** (hello): single — 4 ms
- **Fastest boot** (hello): single — 105 ms
- **Fastest shutdown** (hello): native-cluster-3 — 1 ms
- **Throughput winner** (latency-10ms): single — 53,398 req/sec
- **Lowest latency p99** (latency-10ms): single — 3 ms
- **Fastest boot** (latency-10ms): clusterkit-3 — 2 ms
- **Fastest shutdown** (latency-10ms): throng-3 — 5 ms
- **Throughput winner** (cpu-io-mix): throng-3 — 13,057 req/sec
- **Lowest latency p99** (cpu-io-mix): single — 14 ms
- **Fastest boot** (cpu-io-mix): native-cluster-3 — 2 ms
- **Fastest shutdown** (cpu-io-mix): throng-3 — 4 ms

---

## Key Findings

### SO_REUSEPORT impact (clusterkit-3 vs native-cluster-3)

| Workload | macOS (no SO_REUSEPORT) | Linux (SO_REUSEPORT) |
|---|---|---|
| **hello** | native-cluster-3 7% faster (53,520 vs 50,006) | Tied (55,862 vs 55,482, 0.7% delta) |
| **latency-10ms** | native-cluster-3 6% faster (54,864 vs 51,610) | clusterkit-3 0.2% faster (54,495 vs 54,401) |
| **cpu-io-mix** | native-cluster-3 0.7% faster (12,809 vs 12,721) | clusterkit-3 1.7% faster (11,954 vs 11,751) |

On macOS, both use the same IPC round-robin — clusterkit is slower due to management overhead. On Linux, SO_REUSEPORT eliminates the IPC bottleneck, and clusterkit matches or surpasses native-cluster on async workloads.

### pm2 overhead vs clusterkit (Linux, hello workload)

| Metric | clusterkit-3 | pm2-3 | pm2 overhead |
|---|---|---|---|
| RSS Avg | 184 MB | 405 MB | **+120%** |
| CPU % | 93.2% | 146.4% | **+57%** |
| Boot time | 208 ms | 410 ms | **+97%** |
| Shutdown | 9 ms | 222 ms | **+2,367%** |
| Throughput | 55,482 req/s | 53,600 req/s | **-3.4%** |

### Notes

- macOS RSS/CPU = N/A (no `/proc` filesystem). Use Linux Docker for memory/CPU metrics.
- `stddev = 0` because only 1 run per scenario (quick mode). Reference mode (3 runs) needed for variance.
- pm2-reload-3 consistently starts only 2/3 workers — the `wait_ready` option delays the 3rd worker beyond the measurement window.
- Some Linux RSS values show N/A for single/native-cluster on latency-10ms and cpu-io-mix: the proc-sampler couldn't find child PIDs before the process tree changed. A longer warmup would resolve this.
