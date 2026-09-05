import { readFileSync } from "node:fs";
import http from "node:http";

/**
 * Direct children of a pid, read from /proc/<pid>/task/<pid>/children (Linux
 * only). Same source as ProcSampler._readChildren; a vanished pid yields an
 * empty list.
 */
export function childPids(parentPid) {
  try {
    const content = readFileSync(`/proc/${parentPid}/task/${parentPid}/children`, "utf8");
    // .map(Number.parseInt) would pass the array index as the radix — parse explicitly
    return content
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10));
  } catch {
    return [];
  }
}

/**
 * Crash-recovery scenario: SIGKILL half the workers, then poll the target's
 * HTTP endpoint until every worker slot is serving again. Measures the restore
 * time, per-replacement boot offsets, and requests served while capacity was
 * degraded.
 *
 * Polls over fresh connections (agent: false): keep-alive would pin every
 * request to the surviving worker, so replacements would never be observed.
 * Linux only (/proc pid discovery) — the runner blocks non-Linux platforms
 * before booting a target.
 */
export async function runRecoveryScenario({ targetChild, port, expectedWorkers, measureMs = 10_000 }) {
  const before = childPids(targetChild.pid);
  const victims = before.slice(0, Math.ceil(before.length / 2));
  if (victims.length === 0) {
    throw new Error(
      `no worker processes found under pid ${targetChild.pid} — the recovery scenario needs a multi-worker target`,
    );
  }

  const victimSet = new Set(victims);
  const pidsSeen = new Set();
  let requests = 0;
  let restoreStart = null;
  const bootTimes = [];
  const url = `http://127.0.0.1:${port}/hello`;
  const t0 = Date.now();

  for (const pid of victims) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone — the orchestrator recovers the same way
    }
  }

  for (;;) {
    try {
      const body = await fetchPid(url);
      requests++;
      if (!victimSet.has(body.pid) && !pidsSeen.has(body.pid)) {
        pidsSeen.add(body.pid);
        if (restoreStart === null) restoreStart = Date.now();
        bootTimes.push(Date.now() - restoreStart);
        if (pidsSeen.size >= expectedWorkers) return result(true);
      }
    } catch {
      // connection refused / dropped — capacity down, keep polling
    }
    if (Date.now() - t0 > measureMs) return result(false);
    await sleep(100);
  }

  function result(restored) {
    return {
      restoreDurationMs: Date.now() - t0,
      requestsDuringRecovery: requests,
      bootTimesMs: bootTimes,
      pidsBefore: before,
      pidsKilled: victims,
      restored,
    };
  }
}

/** One-shot GET returning the parsed JSON body (no keep-alive, 2s timeout). */
function fetchPid(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error("poll request timeout")));
    req.on("error", reject);
  });
}

/** Median-aggregate repetition runs into the per-target report shape. */
export function summarizeRecoveryRuns(runs, { workload, health, repetitions }) {
  return {
    workload,
    health,
    repetitions,
    runs,
    median: {
      restoreDurationMs: median(runs.map((r) => r.restoreDurationMs)),
      bootTimesMsMedianMs: median(runs.map((r) => r.bootTimesMsMedian)),
      requestsDuringRecovery: median(runs.map((r) => r.requestsDuringRecovery)),
    },
  };
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
