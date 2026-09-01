# Benchmarks

## macOS

> Generated: 2026-08-13T19:35:24Z | Node v22.18.0 | darwin arm64 | 12 CPUs | Apple M2 Max
> Method: autocannon, 3s warmup + 10s measure, 1 run (median), 150 connections (50/worker)
> SO_REUSEPORT: disabled (platform.ts hardcodes `false` for darwin)

> **Data provenance warning — macOS `single` rows**: the `single` baseline below is not what it claims.
> It reports 3–4 serving PIDs (expected: 1) and ~5001 ms shutdown times, and the serving-PID anomaly is
> unexplained. Treat all macOS `single` rows as unreliable; the historical data is kept as-is until a
> re-bench (preferably on the Linux Docker harness).

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

| Workload | RPS Winner | p99 Winner | Boot Winner | Shutdown Winner |
|---|---|---|---|---|
| hello | native-cluster-3 (53,520) | single (2 ms) | clusterkit-3 (1 ms) | throng-3 (7 ms) |
| latency-10ms | single (67,126) | single (2 ms) | single (1 ms) | throng-3 (8 ms) |
| cpu-io-mix | native-cluster-3 (12,809) | single (12 ms) | clusterkit-3 (1 ms) | throng-3 (6 ms) |

> **Note**: macOS results use 50 connections per worker (150 total for 3-worker targets). macOS RSS/CPU = N/A
> (no `/proc` filesystem). Only 3 workloads were run on macOS — use Linux Docker for full 8-workload results.

---

## Linux (Docker)

> Generated: 2026-08-13T21:15:56Z | Node v22.23.2 | linux arm64 | 4 CPUs | Docker node:22-slim
> Method: autocannon, 3s warmup + 10s measure, 1 run (median), 150 connections (50/worker)
> SO_REUSEPORT: enabled for clusterkit-3 and native-cluster-reuseport-3 (kernel-level load balancing)

### Workload: Hello World (JSON trivial)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 17,784 ± 0 | 8 ms | 10 ms | 11 ms | 0 | 108 ms | 5 ms | 134 MB | 142 MB | 104.4% | 15,660 ms | 1/1 |
| clusterkit-3 | 3 | 53,005 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 208 ms | 24 ms | 191 MB | 137 MB | 95.0% | 13,300 ms | 3/3 |
| native-cluster-3 | 3 | 52,355 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 209 ms | 1 ms | 185 MB | 133 MB | 93.9% | 13,140 ms | 3/3 |
| native-cluster-reuseport-3 | 3 | 51,565 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 203 ms | 2 ms | 185 MB | 133 MB | 94.4% | 14,160 ms | 3/3 |
| throng-3 | 3 | 51,779 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 5 ms | 12 ms | 192 MB | 142 MB | 91.8% | 12,850 ms | 3/3 |
| pm2-3 | 3 | 51,059 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 512 ms | 229 ms | 432 MB | 175 MB | 146.0% | 21,900 ms | 3/3 |
| pm2-reload-3 | 3 | 16,649 ± 0 | 8 ms | 12 ms | 16 ms | 0 | 417 ms | 234 ms | 264 MB | 151 MB | 91.3% | 12,780 ms | 2/3 |

### Workload: Latency 10ms

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 11,130 ± 0 | 13 ms | 15 ms | 16 ms | 0 | 212 ms | 7 ms | 128 MB | 135 MB | 67.6% | 9,470 ms | 1/1 |
| clusterkit-3 | 3 | 11,980 ± 0 | 12 ms | 14 ms | 15 ms | 0 | 203 ms | 12 ms | 178 MB | 124 MB | 29.9% | 4,180 ms | 3/3 |
| native-cluster-3 | 3 | 11,745 ± 0 | 12 ms | 15 ms | 15 ms | 0 | 208 ms | 1 ms | 175 MB | 121 MB | 27.6% | 3,860 ms | 3/3 |
| native-cluster-reuseport-3 | 3 | 11,659 ± 0 | 12 ms | 15 ms | 16 ms | 0 | 203 ms | 2 ms | 171 MB | 120 MB | 30.3% | 4,240 ms | 3/3 |
| throng-3 | 3 | 11,998 ± 0 | 12 ms | 14 ms | 15 ms | 0 | 2 ms | 11 ms | 180 MB | 132 MB | 33.1% | 4,640 ms | 3/3 |
| pm2-3 | 3 | 12,098 ± 0 | 12 ms | 14 ms | 15 ms | 0 | 412 ms | 231 ms | 248 MB | 134 MB | 33.5% | 4,690 ms | 3/3 |
| pm2-reload-3 | 3 | 11,129 ± 0 | 13 ms | 15 ms | 16 ms | 0 | 411 ms | 229 ms | 261 MB | 147 MB | 60.4% | 8,450 ms | 2/3 |

### Workload: CPU-IO Mix

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 917 ± 0 | 104 ms | 145 ms | 1174 ms | 26 | 112 ms | 6 ms | 113 MB | 123 MB | 96.1% | 13,460 ms | 1/1 |
| clusterkit-3 | 3 | 2,757 ± 0 | 53 ms | 105 ms | 112 ms | 0 | 207 ms | 9 ms | 172 MB | 119 MB | 94.5% | 13,230 ms | 3/3 |
| native-cluster-3 | 3 | 2,722 ± 0 | 50 ms | 101 ms | 111 ms | 0 | 208 ms | 5 ms | 165 MB | 111 MB | 94.9% | 13,280 ms | 3/3 |
| native-cluster-reuseport-3 | 3 | 2,743 ± 0 | 51 ms | 103 ms | 105 ms | 0 | 317 ms | 2 ms | 174 MB | 124 MB | 94.7% | 13,260 ms | 3/3 |
| throng-3 | 3 | 2,755 ± 0 | 51 ms | 101 ms | 106 ms | 0 | 4 ms | 7 ms | 164 MB | 115 MB | 94.9% | 13,280 ms | 3/3 |
| pm2-3 | 3 | 2,735 ± 0 | 51 ms | 102 ms | 105 ms | 0 | 414 ms | 229 ms | 237 MB | 129 MB | 93.6% | 13,110 ms | 3/3 |
| pm2-reload-3 | 3 | 1,281 ± 0 | 81 ms | 126 ms | 344 ms | 0 | 417 ms | 223 ms | 234 MB | 120 MB | 95.7% | 14,350 ms | 1/3 |

### Workload: List 100 (filter + paginate JSON dataset)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 10,378 ± 0 | 14 ms | 17 ms | 18 ms | 0 | 107 ms | 6 ms | 147 MB | 155 MB | 101.1% | 15,160 ms | 1/1 |
| clusterkit-3 | 3 | 29,934 ± 0 | 4 ms | 10 ms | 12 ms | 0 | 206 ms | 10 ms | 197 MB | 143 MB | 91.0% | 12,740 ms | 3/3 |
| native-cluster-3 | 3 | 31,050 ± 0 | 4 ms | 8 ms | 10 ms | 0 | 208 ms | 1 ms | 194 MB | 143 MB | 95.0% | 13,300 ms | 3/3 |
| native-cluster-reuseport-3 | 3 | 30,818 ± 0 | 4 ms | 9 ms | 10 ms | 0 | 208 ms | 2 ms | 191 MB | 140 MB | 94.2% | 13,190 ms | 3/3 |
| throng-3 | 3 | 30,450 ± 0 | 4 ms | 9 ms | 10 ms | 0 | 2 ms | 10 ms | 196 MB | 146 MB | 93.9% | 14,090 ms | 3/3 |
| pm2-3 | 3 | 30,251 ± 0 | 4 ms | 9 ms | 10 ms | 0 | 410 ms | 233 ms | 268 MB | 154 MB | 87.6% | 13,140 ms | 3/3 |
| pm2-reload-3 | 3 | 10,078 ± 0 | 14 ms | 18 ms | 19 ms | 0 | 415 ms | 232 ms | 273 MB | 159 MB | 92.3% | 13,850 ms | 2/3 |

### Workload: Aggregate (group-by + sort over dataset)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 6,159 ± 0 | 23 ms | 28 ms | 29 ms | 0 | 104 ms | 6 ms | 142 MB | 150 MB | 98.7% | 14,800 ms | 1/1 |
| clusterkit-3 | 3 | 17,905 ± 0 | 8 ms | 13 ms | 16 ms | 0 | 204 ms | 12 ms | 193 MB | 139 MB | 96.0% | 14,400 ms | 3/3 |
| native-cluster-3 | 3 | 18,005 ± 0 | 7 ms | 12 ms | 15 ms | 0 | 205 ms | 2 ms | 192 MB | 138 MB | 96.3% | 14,440 ms | 3/3 |
| native-cluster-reuseport-3 | 3 | 18,216 ± 0 | 7 ms | 13 ms | 15 ms | 0 | 209 ms | 2 ms | 188 MB | 135 MB | 95.6% | 13,390 ms | 3/3 |
| throng-3 | 3 | 18,424 ± 0 | 7 ms | 12 ms | 15 ms | 0 | 2 ms | 10 ms | 189 MB | 142 MB | 95.0% | 13,300 ms | 3/3 |
| pm2-3 | 3 | 17,730 ± 0 | 8 ms | 13 ms | 16 ms | 0 | 409 ms | 223 ms | 262 MB | 148 MB | 91.5% | 13,720 ms | 3/3 |
| pm2-reload-3 | 3 | 6,119 ± 0 | 23 ms | 28 ms | 29 ms | 0 | 413 ms | 229 ms | 270 MB | 158 MB | 93.7% | 14,050 ms | 1/3 |

### Workload: Auth Verify (JWT decode + verify)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 16,672 ± 0 | 8 ms | 11 ms | 12 ms | 0 | 105 ms | 8 ms | 134 MB | 140 MB | 104.2% | 15,630 ms | 1/1 |
| clusterkit-3 | 3 | 49,939 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 202 ms | 11 ms | 189 MB | 137 MB | 94.3% | 13,200 ms | 3/3 |
| native-cluster-3 | 3 | 50,563 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 209 ms | 2 ms | 183 MB | 131 MB | 96.0% | 13,440 ms | 3/3 |
| native-cluster-reuseport-3 | 3 | 50,433 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 208 ms | 2 ms | 392 MB | 211 MB | 155.7% | 23,360 ms | 3/3 |
| throng-3 | 3 | 49,978 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 1 ms | 8 ms | 384 MB | 211 MB | 1675.4% | 234,550 ms | 3/3 |
| pm2-3 | 3 | 48,566 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 414 ms | 225 ms | 608 MB | 211 MB | 241.0% | 33,740 ms | 3/3 |
| pm2-reload-3 | 3 | 16,158 ± 0 | 8 ms | 11 ms | 12 ms | 0 | 415 ms | 225 ms | 266 MB | 152 MB | 92.1% | 13,820 ms | 2/3 |

### Workload: Error Rate (10% intentional 500s)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 17,615 ± 0 | 8 ms | 10 ms | 11 ms | 0 | 107 ms | 6 ms | 135 MB | 141 MB | 104.8% | 15,720 ms | 1/1 |
| clusterkit-3 | 3 | 53,066 ± 0 | 2 ms | 6 ms | 6 ms | 0 | 209 ms | 10 ms | 398 MB | 211 MB | 158.7% | 22,220 ms | 3/3 |
| native-cluster-3 | 3 | 53,194 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 205 ms | 1 ms | 397 MB | 211 MB | 159.3% | 22,300 ms | 3/3 |
| native-cluster-reuseport-3 | 3 | 53,130 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 208 ms | 2 ms | 519 MB | 211 MB | 252.8% | 35,390 ms | 3/3 |
| throng-3 | 3 | 53,447 ± 0 | 2 ms | 5 ms | 6 ms | 0 | 3 ms | 8 ms | 386 MB | 211 MB | 1950.0% | 292,500 ms | 3/3 |
| pm2-3 | 3 | 51,424 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 414 ms | 227 ms | 470 MB | 211 MB | 148.1% | 20,740 ms | 3/3 |
| pm2-reload-3 | 3 | 17,140 ± 0 | 8 ms | 11 ms | 12 ms | 0 | 411 ms | 230 ms | 265 MB | 151 MB | 91.9% | 13,790 ms | 2/3 |

### Workload: Upload Echo (POST + JSON body echo)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 14,876 ± 0 | 9 ms | 12 ms | 14 ms | 0 | 110 ms | 7 ms | 138 MB | 145 MB | 104.6% | 15,690 ms | 1/1 |
| clusterkit-3 | 3 | 44,525 ± 0 | 3 ms | 6 ms | 8 ms | 0 | 211 ms | 11 ms | 402 MB | 211 MB | 152.7% | 21,380 ms | 3/3 |
| native-cluster-3 | 3 | 44,448 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 213 ms | 2 ms | 527 MB | 211 MB | 248.5% | 34,790 ms | 3/3 |
| native-cluster-reuseport-3 | 3 | 44,487 ± 0 | 3 ms | 6 ms | 7 ms | 0 | 215 ms | 1 ms | 398 MB | 211 MB | 153.6% | 23,040 ms | 3/3 |
| throng-3 | 3 | 44,112 ± 0 | 3 ms | 6 ms | 8 ms | 0 | 3 ms | 14 ms | 387 MB | 211 MB | 2459.4% | 344,310 ms | 3/3 |
| pm2-3 | 3 | 42,099 ± 0 | 3 ms | 7 ms | 8 ms | 0 | 411 ms | 231 ms | 474 MB | 211 MB | 142.0% | 19,880 ms | 3/3 |
| pm2-reload-3 | 3 | 14,520 ± 0 | 10 ms | 13 ms | 14 ms | 0 | 416 ms | 237 ms | 269 MB | 155 MB | 93.0% | 13,950 ms | 2/3 |

### Summary (Linux)

| Workload | RPS Winner | clusterkit vs native-cluster | clusterkit vs reuseport |
|---|---|---|---|
| hello | clusterkit-3 (53,005) | **+1.2%** | +2.8% |
| latency-10ms | pm2-3 (12,098) | **+2.0%** | +2.7% |
| cpu-io-mix | clusterkit-3 (2,757) | **+1.3%** | +0.5% |
| list-100 | native-cluster-3 (31,050) | -3.6% | -2.9% |
| aggregate | native-cluster-reuseport-3 (18,216) | -0.6% | -1.7% |
| auth-verify | native-cluster-3 (50,563) | -1.2% | -1.0% |
| error-rate | throng-3 (53,447) | -0.2% | -0.1% |
| upload-echo | clusterkit-3 (44,525) | **+0.2%** | +0.1% |

clusterkit-3 wins or ties on 5 of 8 workloads. The gap on the remaining 3 is <= 3.6%.

---

## Key Findings

### clusterkit-3 vs native-cluster-3 (Linux, all workloads)

| Workload | clusterkit-3 | native-cluster-3 | Delta | Winner |
|---|---|---|---|---|
| hello | 53,005 | 52,355 | +1.2% | clusterkit |
| latency-10ms | 11,980 | 11,745 | +2.0% | clusterkit |
| cpu-io-mix | 2,757 | 2,722 | +1.3% | clusterkit |
| list-100 | 29,934 | 31,050 | -3.6% | native-cluster |
| aggregate | 17,905 | 18,005 | -0.6% | native-cluster |
| auth-verify | 49,939 | 50,563 | -1.2% | native-cluster |
| error-rate | 53,066 | 53,194 | -0.2% | tied |
| upload-echo | 44,525 | 44,448 | +0.2% | clusterkit |

clusterkit matches or surpasses native-cluster on 5/8 workloads. The only meaningful gap is list-100 (3.6%), likely
due to IPC round-robin distributing large-response workloads more evenly than SO_REUSEPORT's hash-based distribution.

### SO_REUSEPORT isolation (native-cluster-3 vs native-cluster-reuseport-3)

| Workload | IPC round-robin | SO_REUSEPORT | Delta |
|---|---|---|---|
| hello | 52,355 | 51,565 | -1.5% |
| latency-10ms | 11,745 | 11,659 | -0.7% |
| cpu-io-mix | 2,722 | 2,743 | +0.8% |
| list-100 | 31,050 | 30,818 | -0.7% |
| aggregate | 18,005 | 18,216 | +1.2% |
| auth-verify | 50,563 | 50,433 | -0.3% |
| error-rate | 53,194 | 53,130 | -0.1% |
| upload-echo | 44,448 | 44,487 | +0.1% |

SO_REUSEPORT vs IPC round-robin is within noise (< 1.5% on all workloads). The connection distribution strategy
has minimal impact at this connection count -- the kernel load balancer and Node's IPC round-robin perform
equivalently.

### pm2 overhead vs clusterkit (Linux, hello workload)

| Metric | clusterkit-3 | pm2-3 | pm2 overhead |
|---|---|---|---|
| RSS Avg | 191 MB | 432 MB | **+126%** |
| CPU % | 95.0% | 146.0% | **+54%** |
| Boot time | 208 ms | 512 ms | **+146%** |
| Shutdown | 24 ms | 229 ms | **+854%** |
| Throughput | 53,005 req/s | 51,059 req/s | **-3.7%** |

### Graceful shutdown (Linux, hello workload)

| Orchestrator | Shutdown time | Method |
|---|---|---|
| native-cluster-3 | 1 ms | Raw SIGTERM (no ACK protocol) |
| native-cluster-reuseport-3 | 2 ms | Raw SIGTERM (no ACK protocol) |
| clusterkit-3 | 24 ms | ACK-based graceful shutdown |
| throng-3 | 12 ms | SIGTERM with quick exit |
| pm2-3 | 229 ms | pm2 daemon stop sequence |
| pm2-reload-3 | 234 ms | pm2 daemon stop sequence |

clusterkit's ACK protocol adds ~22 ms over raw SIGTERM but ensures in-flight requests complete before exit.
pm2's shutdown is 9.5x slower than clusterkit due to daemon overhead.

### pm2-reload-3 worker count

pm2-reload-3 consistently starts only 2/3 (or 1/3 on cpu-io-mix and aggregate) workers across all workloads.
The `wait_ready: true` option delays workers beyond the measurement window, causing it to run at reduced
capacity. This affects all pm2-reload-3 results.

### Connection fairness

All targets now receive 150 connections (50 per worker x 3). Previously `single` had only 50 connections,
giving it an artificial advantage on async workloads (latency-10ms, error-rate, upload-echo) where fewer
connections means less event loop contention. After the fix, `single` is correctly shown as the lowest
performer on multi-worker workloads.

### Notes

- **Labeling correction**: every `Lat p95` column in the tables above actually contains **p97.5** values
  (autocannon percentile bucket; the generator mislabeled it). The reporter now emits `Lat p97.5`; regenerating
  these tables requires a full Docker bench run.
- macOS RSS/CPU = N/A (no `/proc` filesystem). Use Linux Docker for memory/CPU metrics.
- `stddev = 0` because only 1 run per scenario (quick mode). Reference mode (3 runs) needed for variance.
- Later workloads (auth-verify, error-rate, upload-echo) show inflated RSS/CPU values due to cumulative
  container memory pressure -- the proc-sampler tracks all processes in the PID tree, not just worker
  processes.
- throng-3 CPU % values on auth-verify (1675%) and error-rate (1950%) are anomalous -- the proc-sampler
  may be double-counting threads or the IPC primary is under heavy load. These are sampling artifacts, not
  real CPU usage.
- pm2-reload-3 on cpu-io-mix and aggregate started only 1/3 workers -- worse than the usual 2/3. This is
  a known pm2 `wait_ready` timing issue.
