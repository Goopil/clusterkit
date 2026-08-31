import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeJsonReport(report, outputDir) {
  const path = join(outputDir, "latest.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function buildMarkdownReport(report) {
  const { metadata, results } = report;
  const lines = [];

  lines.push("# Benchmarks");
  lines.push("");
  lines.push(
    `> Generated: ${metadata.generatedAt} | Node ${metadata.nodeVersion} | ${metadata.platform} | ${metadata.cpuCount} CPUs | Docker ${metadata.dockerImage}`,
  );
  lines.push(
    `> Method: autocannon, ${metadata.method.warmupSec}s warmup + ${metadata.method.measureSec}s measure, ${metadata.method.repetitions} runs (median), ${metadata.method.connsPerWorker} conns/worker`,
  );
  lines.push("");

  const workloadLabels = {
    hello: "Hello World (JSON trivial)",
    "latency-10ms": "Latency 10ms",
    "cpu-io-mix": "CPU-IO Mix",
  };

  for (const [workload, label] of Object.entries(workloadLabels)) {
    const workloadResults = results[workload];
    if (!workloadResults) continue;

    lines.push(`## Workload: ${label}`);
    lines.push("");
    lines.push(
      "| Orchestrator | Workers | Req/sec | Lat p50 | Lat p95 | Lat p99 | Errors | Boot | Shutdown | RSS Avg | RSS Peak | CPU % | CPU Time | PIDs Active |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");

    const targetOrder = ["single", "clusterkit-3", "native-cluster-3", "throng-3", "pm2-3", "pm2-reload-3"];

    for (const targetId of targetOrder) {
      const tr = workloadResults[targetId];
      if (!tr) continue;

      const workers = targetId === "single" ? 1 : 3;
      const rpsStr = tr.rps ? `${tr.rps.median.toLocaleString()} ± ${tr.rps.stddev}` : "N/A";
      const latP50 = tr.latency?.p50 != null ? `${tr.latency.p50} ms` : "N/A";
      const latP95 = tr.latency?.p95 != null ? `${tr.latency.p95} ms` : "N/A";
      const latP99 = tr.latency?.p99 != null ? `${tr.latency.p99} ms` : "N/A";
      const errors = tr.errors ?? 0;
      const boot = tr.bootTimeMs != null ? `${tr.bootTimeMs} ms` : "N/A";
      const shutdown = tr.shutdownTimeMs != null ? `${tr.shutdownTimeMs} ms` : "N/A";
      const rssAvg = tr.rss ? formatMb(tr.rss.avgKb) : "N/A";
      const rssPeak = tr.rss ? formatMb(tr.rss.peakKb) : "N/A";
      const cpuPct = tr.cpu ? `${tr.cpu.avgPercent}%` : "N/A";
      const cpuTime = tr.cpu ? `${tr.cpu.timeMs.toLocaleString()} ms` : "N/A";
      const pidsActive = tr.pids ? `${tr.pids.active}/${tr.pids.expected}` : "N/A";

      lines.push(
        `| ${targetId} | ${workers} | ${rpsStr} | ${latP50} | ${latP95} | ${latP99} | ${errors} | ${boot} | ${shutdown} | ${rssAvg} | ${rssPeak} | ${cpuPct} | ${cpuTime} | ${pidsActive} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Summary");
  lines.push("");
  const summary = generateSummary(results);
  for (const line of summary) {
    lines.push(`- ${line}`);
  }
  lines.push("");

  return lines.join("\n");
}

export function writeMarkdownReport(markdown, rootDir) {
  const path = join(rootDir, "BENCHMARKS.md");
  writeFileSync(path, markdown);
}

function formatMb(kb) {
  return `${Math.round(kb / 1024)} MB`;
}

function generateSummary(results) {
  const summary = [];

  for (const [workload, workloadResults] of Object.entries(results)) {
    let bestRps = null;
    let bestRpsTarget = null;
    let bestLatP99 = null;
    let bestLatP99Target = null;
    let bestBoot = null;
    let bestBootTarget = null;
    let bestShutdown = null;
    let bestShutdownTarget = null;

    for (const [targetId, tr] of Object.entries(workloadResults)) {
      if (tr.rps?.median != null && (bestRps === null || tr.rps.median > bestRps)) {
        bestRps = tr.rps.median;
        bestRpsTarget = targetId;
      }
      if (tr.latency?.p99 != null && (bestLatP99 === null || tr.latency.p99 < bestLatP99)) {
        bestLatP99 = tr.latency.p99;
        bestLatP99Target = targetId;
      }
      if (tr.bootTimeMs != null && (bestBoot === null || tr.bootTimeMs < bestBoot)) {
        bestBoot = tr.bootTimeMs;
        bestBootTarget = targetId;
      }
      if (tr.shutdownTimeMs != null && (bestShutdown === null || tr.shutdownTimeMs < bestShutdown)) {
        bestShutdown = tr.shutdownTimeMs;
        bestShutdownTarget = targetId;
      }
    }

    if (bestRpsTarget) {
      const tr = workloadResults[bestRpsTarget];
      summary.push(
        `**Throughput winner** (${workload}): ${bestRpsTarget} — ${bestRps.toLocaleString()}${tr.rps.stddev ? ` ± ${tr.rps.stddev}` : ""} req/sec`,
      );
    }
    if (bestLatP99Target) {
      summary.push(`**Lowest latency p99** (${workload}): ${bestLatP99Target} — ${bestLatP99} ms`);
    }
    if (bestBootTarget) {
      summary.push(`**Fastest boot** (${workload}): ${bestBootTarget} — ${bestBoot} ms`);
    }
    if (bestShutdownTarget) {
      summary.push(`**Fastest shutdown** (${workload}): ${bestShutdownTarget} — ${bestShutdown} ms`);
    }
  }

  return summary;
}
