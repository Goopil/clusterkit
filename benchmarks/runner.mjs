#!/usr/bin/env node

import { fork } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./lib/autocannon-runner.mjs";
import { listAvailable, parseCliArgs, resolveConfig } from "./lib/cli.mjs";
import { checkPidDistribution } from "./lib/pid-distributor.mjs";
import { ProcSampler } from "./lib/proc-sampler.mjs";
import { buildJsonReport, buildMarkdownReport, writeJsonReport, writeMarkdownReport } from "./lib/reporter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
const REPO_ROOT = join(__dirname, "..");

const ALL_TARGETS = ["single", "clusterkit-3", "native-cluster-3", "throng-3", "pm2-3", "pm2-reload-3"];
const ALL_WORKLOADS = ["hello", "latency-10ms", "cpu-io-mix"];
const EXPECTED_PIDS = {
  single: 1,
  "clusterkit-3": 3,
  "native-cluster-3": 3,
  "throng-3": 3,
  "pm2-3": 3,
  "pm2-reload-3": 3,
};

async function main() {
  const cli = parseCliArgs();

  if (cli.list) {
    listAvailable();
    return;
  }

  const config = resolveConfig(cli);
  const targets = cli.target ? [cli.target] : ALL_TARGETS;
  const workloads = cli.workload ? [cli.workload] : ALL_WORKLOADS;

  if (cli.smoke) {
    await runSmokeTest(targets, workloads, config.port);
    return;
  }

  console.log("\n=== Benchmark Suite ===");
  console.log(
    `Mode: ${config.mode} | Warmup: ${config.warmupSec}s | Measure: ${config.measureSec}s | Repetitions: ${config.repetitions}`,
  );
  console.log(`Targets: ${targets.join(", ")}`);
  console.log(`Workloads: ${workloads.join(", ")}`);
  console.log(`Port: ${config.port}\n`);

  const results = {};
  const startTime = Date.now();

  for (const workload of workloads) {
    results[workload] = {};
    for (const target of targets) {
      console.log(`\n--- Running ${target} / ${workload} ---`);
      try {
        const scenarioResult = await runScenarioForTarget(target, workload, config);
        results[workload][target] = scenarioResult;
        console.log(`  RPS: ${scenarioResult.rps?.median ?? "N/A"} ± ${scenarioResult.rps?.stddev ?? "N/A"}`);
        console.log(`  Boot: ${scenarioResult.bootTimeMs}ms | Shutdown: ${scenarioResult.shutdownTimeMs}ms`);
      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
        results[workload][target] = { failed: true, error: err.message };
      }
    }
  }

  const metadata = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || "unknown",
    dockerImage: "node:22-slim",
    method: {
      warmupSec: config.warmupSec,
      measureSec: config.measureSec,
      repetitions: config.repetitions,
      connsPerWorker: config.connsPerWorker,
      mode: config.mode,
    },
  };

  const report = buildJsonReport(metadata, results);
  writeJsonReport(report, RESULTS_DIR);

  const markdown = buildMarkdownReport(report);
  writeMarkdownReport(markdown, REPO_ROOT);

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== Done in ${elapsed}s ===`);
  console.log(`JSON: ${join(RESULTS_DIR, "latest.json")}`);
  console.log(`Markdown: ${join(REPO_ROOT, "BENCHMARKS.md")}`);
}

async function runScenarioForTarget(target, workload, config) {
  const targetScript = join(__dirname, "targets", `${target}.mjs`);
  const url = `http://127.0.0.1:${config.port}`;
  const connections = target === "single" ? config.connsPerWorker : config.connsPerWorker * 3;

  const bootStartTs = Date.now();
  const child = fork(targetScript, [], {
    env: { ...process.env, PORT: String(config.port), BENCH_WORKLOAD: workload },
    stdio: "pipe",
  });

  child.on("error", (err) => {
    console.error("  Target process error:", err.message);
  });

  try {
    await waitForPort(config.port, 10000);
    const bootReadyTs = Date.now();
    const bootTimeMs = bootReadyTs - bootStartTs;

    const sampler = new ProcSampler(child.pid, 1000);
    sampler.start();

    const healthCheckInterval = setInterval(async () => {
      const ok = await checkPort(config.port, 1000);
      if (!ok) {
        console.error("  WARNING: target unresponsive during measurement");
      }
    }, 1000);

    try {
      const scenarioResult = await runScenario({
        url,
        connections,
        warmupSec: config.warmupSec,
        measureSec: config.measureSec,
        repetitions: config.repetitions,
      });

      const pidDist = await checkPidDistribution(url);

      clearInterval(healthCheckInterval);
      sampler.stop();

      const shutdownStartTs = Date.now();
      child.kill("SIGTERM");
      await waitForChildExit(child, 5000);
      const shutdownEndTs = Date.now();
      const shutdownTimeMs = shutdownEndTs - shutdownStartTs;

      const stats = sampler.getStats();
      const expectedPids = EXPECTED_PIDS[target] || 3;

      return {
        ...scenarioResult,
        bootTimeMs,
        shutdownTimeMs,
        rss: { avgKb: stats.avgRssKb, peakKb: stats.peakRssKb },
        heap: null,
        cpu: { avgPercent: stats.avgCpuPercent, timeMs: stats.cpuTimeMs },
        pids: {
          active: pidDist.active,
          expected: expectedPids,
          distribution: pidDist.distribution,
        },
      };
    } finally {
      clearInterval(healthCheckInterval);
      sampler.stop();
    }
  } finally {
    if (child.exitCode === null && child.killed === false) {
      child.kill("SIGKILL");
    }
  }
}

async function runSmokeTest(targets, workloads, port) {
  console.log("\n=== Smoke Test ===\n");
  for (const target of targets) {
    for (const workload of workloads) {
      try {
        const targetScript = join(__dirname, "targets", `${target}.mjs`);
        console.log(`Booting ${target} / ${workload}...`);
        const child = fork(targetScript, [], {
          env: { ...process.env, PORT: String(port), BENCH_WORKLOAD: workload },
          stdio: "pipe",
        });
        await waitForPort(port, 10000);
        console.log(`  OK — listening on :${port}`);
        child.kill("SIGTERM");
        await waitForChildExit(child, 5000);
        await sleep(500);
      } catch (err) {
        console.error(`  FAIL: ${err.message}`);
      }
    }
  }
  console.log("\nSmoke test complete.");
}

function waitForPort(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const socket = new net.Socket();
      socket.setTimeout(100);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`port ${port} not ready after ${timeoutMs}ms`));
        } else {
          setTimeout(poll, 100);
        }
      });
      socket.connect(port, "127.0.0.1");
    };
    poll();
  });
}

function checkPort(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

function waitForChildExit(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, timeoutMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
