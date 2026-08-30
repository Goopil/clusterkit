# Benchmarks

> Generated: 2026-08-13T19:35:24.391Z | Node v22.18.0 | darwin arm64 | 12 CPUs | Docker node:22-slim
> Method: autocannon, 3s warmup + 10s measure, 1 runs (median), 50 conns/worker

## Workload: Hello World (JSON trivial)

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 37,334 ± 0 | 1 ms | 2 ms | 2 ms | 0 | 2 ms | 5001 ms | 0 MB | 0 MB | 0% | 0 ms | 3/1 |
| clusterkit-3 | 3 | 50,006 ± 0 | 2 ms | 6 ms | 8 ms | 0 | 1 ms | 2361 ms | 0 MB | 0 MB | 0% | 0 ms | 3/3 |
| native-cluster-3 | 3 | 53,520 ± 0 | 2 ms | 4 ms | 5 ms | 0 | 1 ms | 5001 ms | 0 MB | 0 MB | 0% | 0 ms | 3/3 |
| throng-3 | 3 | 51,181 ± 0 | 2 ms | 5 ms | 6 ms | 0 | 2 ms | 7 ms | 0 MB | 0 MB | 0% | 0 ms | 3/3 |
| pm2-3 | 3 | 48,202 ± 0 | 2 ms | 8 ms | 9 ms | 49 | 1 ms | 280 ms | 0 MB | 0 MB | 0% | 0 ms | 3/3 |
| pm2-reload-3 | 3 | 17,144 ± 0 | 8 ms | 11 ms | 11 ms | 0 | 608 ms | 5002 ms | 0 MB | 0 MB | 0% | 0 ms | 2/3 |

## Workload: Latency 10ms

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 67,126 ± 0 | 0 ms | 1 ms | 2 ms | 0 | 1 ms | 5001 ms | 0 MB | 0 MB | 0% | 0 ms | 4/1 |
| clusterkit-3 | 3 | 51,610 ± 0 | 2 ms | 5 ms | 7 ms | 0 | 1 ms | 2354 ms | 0 MB | 0 MB | 0% | 0 ms | 3/3 |
| native-cluster-3 | 3 | 54,864 ± 0 | 2 ms | 4 ms | 5 ms | 0 | 1 ms | 5000 ms | 0 MB | 0 MB | 0% | 0 ms | 3/3 |
| throng-3 | 3 | 43,475 ± 0 | 2 ms | 8 ms | 10 ms | 0 | 1 ms | 8 ms | 0 MB | 0 MB | 0% | 0 ms | 3/3 |
| pm2-3 | 3 | 22,779 ± 0 | 3 ms | 23 ms | 25 ms | 37 | 1 ms | 281 ms | 0 MB | 0 MB | 0% | 0 ms | 3/3 |
| pm2-reload-3 | 3 | 11,648 ± 0 | 12 ms | 14 ms | 15 ms | 0 | 607 ms | 5002 ms | 0 MB | 0 MB | 0% | 0 ms | 2/3 |

## Workload: CPU-IO Mix

| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single | 1 | 4,362 ± 0 | 11 ms | 12 ms | 12 ms | 0 | 2 ms | 5000 ms | 0 MB | 0 MB | 0% | 0 ms | 4/1 |
| clusterkit-3 | 3 | 12,721 ± 0 | 11 ms | 13 ms | 14 ms | 0 | 1 ms | 2170 ms | 0 MB | 0 MB | 0% | 0 ms | 3/3 |
| native-cluster-3 | 3 | 12,809 ± 0 | 11 ms | 13 ms | 13 ms | 0 | 1 ms | 5001 ms | 0 MB | 0 MB | 0% | 0 ms | 3/3 |
| throng-3 | 3 | 12,445 ± 0 | 11 ms | 14 ms | 17 ms | 0 | 2 ms | 6 ms | 0 MB | 0 MB | 0% | 0 ms | 3/3 |
| pm2-3 | 3 | 8,914 ± 0 | 12 ms | 110 ms | 130 ms | 0 | 1 ms | 274 ms | 0 MB | 0 MB | 0% | 0 ms | 2/3 |
| pm2-reload-3 | 3 | 1,099 ± 0 | 89 ms | 260 ms | 977 ms | 0 | 505 ms | 5002 ms | 0 MB | 0 MB | 0% | 0 ms | 2/3 |

## Summary

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
