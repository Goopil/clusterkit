import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { AggregatorRegistry, Registry } from "prom-client";

import { createPrometheusPlugin } from "../dist/index.js";

function mockOrchestrator(activeWorkers = 0) {
  const emitter = new EventEmitter();
  emitter.currentActiveWorkers = activeWorkers;
  emitter.getMetrics = () => ({ activeWorkers: emitter.currentActiveWorkers });
  return emitter;
}

function percentile(values, p) {
  if (values.length === 0) return 0;

  const sorted = [...values].toSorted((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

function formatNumber(value) {
  return Number(value).toFixed(3);
}

async function runScenario({ workerCount, scrapesPerBurst, ttlMs }) {
  const plugin = createPrometheusPlugin({
    defaultMetrics: false,
    registry: new Registry(),
    metricsCacheTtlMs: ttlMs,
  });

  const orchestrator = mockOrchestrator(workerCount);
  await plugin.install(orchestrator, null);

  // Warm-up
  for (let i = 0; i < 5; i++) {
    await plugin.getMetrics();
  }

  const latencies = [];
  let totalCpuMicros = 0;
  const bursts = 100;
  const totalScrapes = bursts * scrapesPerBurst;

  for (let burstIndex = 0; burstIndex < bursts; burstIndex++) {
    for (let scrapeIndex = 0; scrapeIndex < scrapesPerBurst; scrapeIndex++) {
      const cpuStart = process.cpuUsage();
      const t0 = performance.now();
      await plugin.getMetrics();
      latencies.push(performance.now() - t0);
      const cpu = process.cpuUsage(cpuStart);
      totalCpuMicros += cpu.user + cpu.system;
    }
  }

  await plugin.uninstall();

  return {
    p95LatencyMs: percentile(latencies, 95),
    avgLatencyMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    cpuMsPer1000Scrapes: (totalCpuMicros / 1000 / totalScrapes) * 1000,
  };
}

let syntheticWorkerCount = 1;
const originalClusterMetrics = AggregatorRegistry.prototype.clusterMetrics;

AggregatorRegistry.prototype.clusterMetrics = async function clusterMetricsBenchmarkStub() {
  let out = "";
  for (let i = 0; i < syntheticWorkerCount; i++) {
    out += `nodejs_heap_size_total_bytes{pid="${1000 + i}"} ${5000000 + i}\n`;
    out += `nodejs_eventloop_lag_seconds{pid="${1000 + i}"} ${0.01 + i / 10000}\n`;
  }
  return out;
};

const workerCounts = [1, 8, 32];
const scrapeFrequencies = [1, 10, 50];
const cacheTtls = [0, 250];

console.log("# Prometheus metrics cache benchmark");
console.log(
  "# Run with: corepack pnpm --filter @goopil/clusterkit-prometheus build && corepack pnpm --filter @goopil/clusterkit-prometheus bench:metrics-cache",
);
console.log(
  "# Matrix columns: workers, scrapes_per_burst, cache_ttl_ms, p95_latency_ms, avg_latency_ms, cpu_ms_per_1000_scrapes\n",
);
console.log("workers\tscrapes_per_burst\tcache_ttl_ms\tp95_latency_ms\tavg_latency_ms\tcpu_ms_per_1000_scrapes");

try {
  for (const workerCount of workerCounts) {
    syntheticWorkerCount = workerCount;

    for (const scrapesPerBurst of scrapeFrequencies) {
      for (const ttlMs of cacheTtls) {
        const result = await runScenario({ workerCount, scrapesPerBurst, ttlMs });
        console.log(
          [
            workerCount,
            scrapesPerBurst,
            ttlMs,
            formatNumber(result.p95LatencyMs),
            formatNumber(result.avgLatencyMs),
            formatNumber(result.cpuMsPer1000Scrapes),
          ].join("\t"),
        );
      }
    }
  }
} finally {
  AggregatorRegistry.prototype.clusterMetrics = originalClusterMetrics;
}
