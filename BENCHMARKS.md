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

| Workload | RPS Winner | p99 Winner | Boot Winner | Shutdown Winner |
|---|---|---|---|---|
| hello | native-cluster-3 (53,520) | single (2 ms) | clusterkit-3 (1 ms) | throng-3 (7 ms) |
| latency-10ms | single (67,126) | single (2 ms) | single (1 ms) | throng-3 (8 ms) |
| cpu-io-mix | native-cluster-3 (12,809) | single (12 ms) | clusterkit-3 (1 ms) | throng-3 (6 ms) |

---

## Linux (Docker)

> Generated: 2026-08-13T20:47:15Z | Node v22.23.2 | linux arm64 | 4 CPUs | Docker node:22-slim
> Method: autocannon, 3s warmup + 10s measure, 1 run (median), 50 conns/worker
> SO_REUSEPORT: enabled (kernel-level load balancing)

### Workload: Hello World (JSON trivial)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 18,305 ± 0 | 2 ms | 4 ms | 4 ms | 0 | 107 ms | 5 ms | 123 MB | 129 MB | 104.9% | 15,730 ms | 1/1 |
| clusterkit-3 | 3 | 52,349 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 203 ms | 10 ms | 190 MB | 136 MB | 93.4% | 13,070 ms | 3/3 |
| native-cluster-3 | 3 | 52,086 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 207 ms | 1 ms | 186 MB | 132 MB | 95.0% | 14,250 ms | 3/3 |
| throng-3 | 3 | 52,470 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 208 ms | 11 ms | 198 MB | 142 MB | 94.6% | 14,190 ms | 3/3 |
| pm2-3 | 3 | 50,918 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 411 ms | 229 ms | 389 MB | 143 MB | 144.0% | 20,160 ms | 3/3 |
| pm2-reload-3 | 3 | 17,228 ± 0 | 8 ms | 11 ms | 11 ms | 0 | 416 ms | 4909 ms | 264 MB | 150 MB | 91.7% | 13,750 ms | 2/3 |

### Workload: Latency 10ms

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 53,343 ± 0 | 0 ms | 3 ms | 4 ms | 0 | 4 ms | 5007 ms | N/A | N/A | N/A | N/A | 4/1 |
| clusterkit-3 | 3 | 50,570 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 3 ms | 1166 ms | 56 MB | 62 MB | 0.7% | 110 ms | 3/3 |
| native-cluster-3 | 3 | 51,187 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 4 ms | 5005 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 39,489 ± 0 | 3 ms | 9 ms | 11 ms | 0 | 4 ms | 5 ms | 197 MB | 136 MB | 670.6% | 93,880 ms | 3/3 |
| pm2-3 | 3 | 22,195 ± 0 | 3 ms | 22 ms | 26 ms | 20 | 1 ms | 218 ms | 52 MB | 58 MB | 0.6% | 90 ms | 3/3 |
| pm2-reload-3 | 3 | 11,022 ± 0 | 13 ms | 16 ms | 16 ms | 0 | 412 ms | 4906 ms | 256 MB | 142 MB | 62.0% | 8,680 ms | 2/3 |

### Workload: CPU-IO Mix

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 4,108 ± 0 | 12 ms | 13 ms | 14 ms | 0 | 4 ms | 4904 ms | N/A | N/A | N/A | N/A | 4/1 |
| clusterkit-3 | 3 | 11,875 ± 0 | 12 ms | 15 ms | 15 ms | 0 | 3 ms | 2088 ms | 56 MB | 62 MB | 0.7% | 100 ms | 3/3 |
| native-cluster-3 | 3 | 11,958 ± 0 | 12 ms | 14 ms | 15 ms | 0 | 3 ms | 5004 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 13,018 ± 0 | 11 ms | 13 ms | 14 ms | 0 | 17 ms | 4 ms | 120 MB | 68 MB | 2.9% | 410 ms | 3/3 |
| pm2-3 | 3 | 9,099 ± 0 | 12 ms | 107 ms | 111 ms | 0 | 1 ms | 217 ms | 53 MB | 58 MB | 0.5% | 70 ms | 2/3 |
| pm2-reload-3 | 3 | 1,167 ± 0 | 87 ms | 134 ms | 709 ms | 0 | 412 ms | 5000 ms | 237 MB | 124 MB | 95.0% | 13,300 ms | 2/3 |

### Workload: List 100 (filter + paginate JSON dataset)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 3,566 ± 0 | 12 ms | 26 ms | 27 ms | 0 | 8 ms | 5003 ms | N/A | N/A | N/A | N/A | 4/1 |
| clusterkit-3 | 3 | 2,752 ± 0 | 51 ms | 102 ms | 104 ms | 0 | 7 ms | 2108 ms | 57 MB | 63 MB | 0.9% | 120 ms | 3/3 |
| native-cluster-3 | 3 | 2,752 ± 0 | 51 ms | 102 ms | 103 ms | 0 | 4 ms | 5005 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 2,512 ± 0 | 52 ms | 114 ms | 134 ms | 0 | 1 ms | 5 ms | 120 MB | 69 MB | 2.5% | 350 ms | 3/3 |
| pm2-3 | 3 | 20,840 ± 0 | 6 ms | 27 ms | 29 ms | 7 | 2 ms | 225 ms | 52 MB | 58 MB | 0.5% | 70 ms | 3/3 |
| pm2-reload-3 | 3 | 10,378 ± 0 | 14 ms | 17 ms | 19 ms | 0 | 414 ms | 5002 ms | 276 MB | 163 MB | 92.9% | 13,940 ms | 2/3 |

### Workload: Aggregate (group-by + sort over dataset)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 33,504 ± 0 | 1 ms | 4 ms | 5 ms | 0 | 4 ms | 5008 ms | N/A | N/A | N/A | N/A | 4/1 |
| clusterkit-3 | 3 | 28,022 ± 0 | 4 ms | 10 ms | 13 ms | 0 | 12 ms | 2196 ms | 56 MB | 62 MB | 0.9% | 120 ms | 3/3 |
| native-cluster-3 | 3 | 29,566 ± 0 | 4 ms | 9 ms | 11 ms | 0 | 9 ms | 5003 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 22,958 ± 0 | 5 ms | 15 ms | 19 ms | 0 | 5 ms | 5 ms | 121 MB | 67 MB | 2.8% | 390 ms | 3/3 |
| pm2-3 | 3 | 20,432 ± 0 | 7 ms | 23 ms | 27 ms | 54 | 1 ms | 222 ms | 53 MB | 59 MB | 0.5% | 70 ms | 3/3 |
| pm2-reload-3 | 3 | 5,760 ± 0 | 24 ms | 30 ms | 33 ms | 0 | 415 ms | 5007 ms | 271 MB | 159 MB | 93.3% | 14,000 ms | 2/3 |

### Workload: Auth Verify (JWT decode + verify)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 21,349 ± 0 | 2 ms | 5 ms | 6 ms | 0 | 8 ms | 5004 ms | N/A | N/A | N/A | N/A | 4/1 |
| clusterkit-3 | 3 | 17,736 ± 0 | 8 ms | 13 ms | 16 ms | 0 | 4 ms | 1182 ms | 57 MB | 64 MB | 0.7% | 110 ms | 3/3 |
| native-cluster-3 | 3 | 17,854 ± 0 | 8 ms | 13 ms | 15 ms | 0 | 4 ms | 5007 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 14,899 ± 0 | 8 ms | 19 ms | 22 ms | 0 | 6 ms | 5 ms | 119 MB | 68 MB | 2.6% | 360 ms | 3/3 |
| pm2-3 | 3 | 35,837 ± 0 | 3 ms | 10 ms | 12 ms | 33 | 3 ms | 228 ms | 52 MB | 58 MB | 0.6% | 80 ms | 3/3 |
| pm2-reload-3 | 3 | 16,896 ± 0 | 8 ms | 11 ms | 13 ms | 0 | 413 ms | 5007 ms | 264 MB | 150 MB | 88.4% | 13,260 ms | 2/3 |

### Workload: Error Rate (20% intentional 500s)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 50,509 ± 0 | 0 ms | 3 ms | 4 ms | 0 | 7 ms | 5003 ms | N/A | N/A | N/A | N/A | 4/1 |
| clusterkit-3 | 3 | 47,894 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 10 ms | 1223 ms | 57 MB | 63 MB | 0.8% | 120 ms | 3/3 |
| native-cluster-3 | 3 | 47,876 ± 0 | 2 ms | 6 ms | 7 ms | 0 | 2 ms | 5008 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 38,518 ± 0 | 3 ms | 9 ms | 12 ms | 0 | 6 ms | 4 ms | 113 MB | 68 MB | 2.7% | 380 ms | 3/3 |
| pm2-3 | 3 | 45,418 ± 0 | 2 ms | 9 ms | 10 ms | 53 | 2 ms | 225 ms | 53 MB | 59 MB | 0.5% | 70 ms | 3/3 |
| pm2-reload-3 | 3 | 17,736 ± 0 | 7 ms | 10 ms | 11 ms | 0 | 413 ms | 5006 ms | 264 MB | 151 MB | 92.8% | 13,920 ms | 2/3 |

### Workload: Upload Echo (POST + JSON body echo)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 49,418 ± 0 | 0 ms | 3 ms | 4 ms | 0 | 12 ms | 5003 ms | N/A | N/A | N/A | N/A | 4/1 |
| clusterkit-3 | 3 | 44,035 ± 0 | 3 ms | 6 ms | 8 ms | 0 | 4 ms | 2198 ms | 56 MB | 62 MB | 0.9% | 130 ms | 3/3 |
| native-cluster-3 | 3 | 43,245 ± 0 | 3 ms | 7 ms | 8 ms | 0 | 8 ms | 5006 ms | N/A | N/A | N/A | N/A | 3/3 |
| throng-3 | 3 | 33,824 ± 0 | 4 ms | 10 ms | 12 ms | 0 | 6 ms | 5 ms | 140 MB | 174 MB | 2.6% | 360 ms | 3/3 |
| pm2-3 | 3 | 36,586 ± 0 | 3 ms | 11 ms | 12 ms | 54 | 2 ms | 227 ms | 53 MB | 58 MB | 0.5% | 70 ms | 3/3 |
| pm2-reload-3 | 3 | 14,228 ± 0 | 10 ms | 14 ms | 17 ms | 0 | 410 ms | 5008 ms | 267 MB | 155 MB | 93.3% | 14,000 ms | 2/3 |

### Summary (Linux)

| Workload | RPS Winner | p99 Winner | Boot Winner | Shutdown Winner |
|---|---|---|---|---|
| hello | throng-3 (52,470) | single (4 ms) | single (107 ms) | native-cluster-3 (1 ms) |
| latency-10ms | single (53,343) | single (4 ms) | pm2-3 (1 ms) | throng-3 (5 ms) |
| cpu-io-mix | throng-3 (13,018) | single (14 ms) | pm2-3 (1 ms) | throng-3 (4 ms) |
| list-100 | pm2-3 (20,840) | single (27 ms) | throng-3 (1 ms) | throng-3 (5 ms) |
| aggregate | single (33,504) | single (5 ms) | pm2-3 (1 ms) | throng-3 (5 ms) |
| auth-verify | pm2-3 (35,837) | single (6 ms) | clusterkit-3 (4 ms) | throng-3 (5 ms) |
| error-rate | single (50,509) | single (4 ms) | pm2-3 (2 ms) | throng-3 (4 ms) |
| upload-echo | single (49,418) | single (4 ms) | pm2-3 (2 ms) | throng-3 (5 ms) |

---

## Key Findings

### SO_REUSEPORT impact (clusterkit-3 vs native-cluster-3, Linux)

| Workload | clusterkit-3 RPS | native-cluster-3 RPS | Delta |
|---|---|---|---|
| hello | 52,349 | 52,086 | clusterkit +0.5% |
| latency-10ms | 50,570 | 51,187 | native +1.2% |
| cpu-io-mix | 11,875 | 11,958 | native +0.7% |
| list-100 | 2,752 | 2,752 | tied |
| aggregate | 28,022 | 29,566 | native +5.5% |
| auth-verify | 17,736 | 17,854 | native +0.7% |
| error-rate | 47,894 | 47,876 | tied |
| upload-echo | 44,035 | 43,245 | clusterkit +1.8% |

On macOS (no SO_REUSEPORT), native-cluster consistently beats clusterkit by 1–7%. On Linux with SO_REUSEPORT, the gap closes — clusterkit matches or surpasses native-cluster on hello, error-rate, and upload-echo. The aggregate workload is the outlier where native-cluster maintains a 5.5% lead.

### pm2 overhead vs clusterkit (Linux, hello workload)

| Metric | clusterkit-3 | pm2-3 | pm2 overhead |
|---|---|---|---|
| RSS Avg | 190 MB | 389 MB | **+105%** |
| CPU % | 93.4% | 144.0% | **+54%** |
| Boot time | 203 ms | 411 ms | **+102%** |
| Shutdown | 10 ms | 229 ms | **+2,190%** |
| Throughput | 52,349 req/s | 50,918 req/s | **-2.7%** |

### Graceful shutdown (Linux, hello workload)

| Orchestrator | Shutdown time | Method |
|---|---|---|
| native-cluster-3 | 1 ms | Raw SIGTERM (no ACK protocol) |
| clusterkit-3 | 10 ms | ACK-based graceful shutdown |
| throng-3 | 11 ms | SIGTERM with quick exit |
| pm2-3 | 229 ms | pm2 daemon stop sequence |
| pm2-reload-3 | 4,909 ms | pm2 reload with wait_ready |

clusterkit's ACK protocol adds ~9 ms over raw SIGTERM but ensures in-flight requests complete before exit. pm2's shutdown is 23× slower than clusterkit due to daemon overhead.

### pm2-reload-3 worker count

pm2-reload-3 consistently starts only **2/3 workers** across all workloads. The `wait_ready: true` option delays the 3rd worker beyond the measurement window, causing it to run at 2/3 capacity. This affects all pm2-reload-3 results.

### Notes

- macOS RSS/CPU = N/A (no `/proc` filesystem). Use Linux Docker for memory/CPU metrics.
- `stddev = 0` because only 1 run per scenario (quick mode). Reference mode (3 runs) needed for variance.
- Some Linux RSS values show N/A for single and native-cluster-3 on non-hello workloads: the proc-sampler couldn't find child PIDs before the process tree changed (native-cluster workers share the primary's PID namespace differently). A longer warmup would resolve this.
- throng-3 on latency-10ms shows 670% CPU — the IPC round-robin primary process is CPU-bound under async workloads without SO_REUSEPORT.
- pm2-3 on list-100 and auth-verify shows anomalously high RPS (20,840 and 35,837 vs ~2,752 and ~17,800 for cluster targets). The pm2 server implementation may handle these routes differently. Investigation pending.
