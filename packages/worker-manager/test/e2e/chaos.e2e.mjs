// Linux-only chaos suite for the worker health & recovery subsystem.
// Spawns the fixture primary (health-fixture.mjs), injects failures — SIGKILL,
// event-loop wedge, boot loop — and asserts recovery through the public
// surfaces: HTTP serving, orchestrator events echoed on stdout, and the
// Prometheus plugin output. Runs via the `e2e-health` compose service
// (`docker compose run e2e-health`); on non-Linux hosts it reports "skipped"
// and exits 0 — the real assertions happen in the container.

import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(new URL("./health-fixture.mjs", import.meta.url));
const ONLINE_WAIT_MS = 15_000;
const RECOVERY_BUDGET_MS = 15_000;
const SETTLE_MS = 500;
const POLL_INTERVAL_MS = 100;

if (process.platform !== "linux" || !process.env.CKX_E2E) {
  console.log("skipped (Linux e2e)");
  process.exit(0);
}

// Copied from benchmarks/lib/recovery-runner.mjs (private package, not
// importable across package boundaries). Direct children of a pid, read from
// /proc/<pid>/task/<pid>/children (Linux only); a vanished pid yields an
// empty list.
function childPids(parentPid) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** One-shot GET over a fresh connection (keep-alive would pin every poll to one worker). */
function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("poll request timeout")));
    req.on("error", reject);
  });
}

function startFixture(scenario, appPort, metricsPort = 0) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "ckx-e2e-"));
  const child = fork(FIXTURE_PATH, [], {
    env: {
      ...process.env,
      CKX_E2E: "1",
      CKX_SCENARIO: scenario,
      PORT: String(appPort),
      ...(metricsPort ? { CKX_METRICS_PORT: String(metricsPort) } : {}),
      CKX_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const events = [];
  const raw = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      raw.push(line);
      if (line.startsWith("{")) {
        try {
          events.push(JSON.parse(line));
        } catch {
          /* not an event line */
        }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return { child, events, raw, stderr, stateDir, appPort };
}

async function stopFixture(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // 'exit' fires exactly once — a single awaited promise covers both the
  // graceful path and the SIGKILL escalation below.
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const forceKillTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 12_000);
  forceKillTimer.unref();
  await exited;
}

async function waitForAppPort(fixture, url) {
  const deadline = Date.now() + ONLINE_WAIT_MS;
  for (;;) {
    try {
      const { status } = await httpGet(url, 1500);
      if (status === 200) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`fixture app port never came up — stderr:\n${fixture.stderr.slice(-2000)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function waitForOnline(fixture, count) {
  const deadline = Date.now() + ONLINE_WAIT_MS;
  for (;;) {
    const pids = new Set(fixture.events.filter((e) => e.event === "worker:online").map((e) => e.pid));
    if (pids.size >= count) return pids;
    if (Date.now() > deadline) throw new Error(`expected ${count} workers online, saw ${pids.size}`);
    await sleep(POLL_INTERVAL_MS);
  }
}

async function waitForEvent(fixture, event, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = fixture.events.find((e) => e.event === event);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Worker pids alive under the fixture primary (read from /proc). */
function liveWorkerPids(fixture) {
  return childPids(fixture.child.pid);
}

// ============================================================================
// Scenarios
// ============================================================================

/** Kill chaos: SIGKILL half the fleet, expect full replacement + degraded/recovered events. */
async function scenarioKill(fixture, check) {
  await waitForAppPort(fixture, `http://127.0.0.1:${fixture.appPort}/`);
  const online = await waitForOnline(fixture, 4);
  const alive = liveWorkerPids(fixture);
  const victims = [...online].filter((pid) => alive.includes(pid)).slice(0, 2);
  check("4 worker pids found under the primary", victims.length === 2, `pids=${alive.join(",")}`);

  const url = `http://127.0.0.1:${fixture.appPort}/`;
  const t0 = Date.now();
  for (const pid of victims) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone — the orchestrator recovers the same way */
    }
  }

  const seen = new Set();
  const replacements = new Set();
  let replaced = false;
  while (Date.now() - t0 < RECOVERY_BUDGET_MS) {
    if (Date.now() - t0 > SETTLE_MS) {
      try {
        const { status, body } = await httpGet(url);
        if (status === 200) {
          const { pid } = JSON.parse(body);
          seen.add(pid);
          if (!online.has(pid)) replacements.add(pid);
          if (seen.size >= 4 && replacements.size >= 2) {
            replaced = true;
            break;
          }
        }
      } catch {
        /* capacity down — keep polling */
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  check("all workers replaced within 15 s", replaced, `served=${[...seen].join(",")}`);

  const degradedIdx = fixture.events.findIndex((e) => e.event === "fleet:degraded");
  const recoveredIdx = fixture.events.findIndex((e) => e.event === "fleet:recovered");
  check("fleet:degraded emitted", degradedIdx >= 0);
  check("fleet:recovered emitted after degradation", recoveredIdx > degradedIdx);
  check("primary still alive", fixture.child.exitCode === null && fixture.child.signalCode === null);
}

/** Wedge chaos: a frozen event loop must be detected and escalated to SIGKILL. */
async function scenarioWedge(fixture, check) {
  await waitForAppPort(fixture, `http://127.0.0.1:${fixture.appPort}/`);
  const online = await waitForOnline(fixture, 4);
  const url = `http://127.0.0.1:${fixture.appPort}/`;
  const t0 = Date.now();

  const wedged = await waitForEvent(fixture, "worker:wedged", RECOVERY_BUDGET_MS);
  check("worker:wedged event observed", wedged !== null, JSON.stringify(wedged ?? {}));
  check(
    "wedged after the 2 s heartbeat silence",
    wedged !== null && wedged.silentMs >= 2000,
    `silentMs=${wedged?.silentMs}`,
  );
  check(
    "worker:recycle reason=wedged",
    fixture.events.some((e) => e.event === "worker:recycle" && e.reason === "wedged"),
  );

  let replacementOnline = false;
  while (Date.now() - t0 < RECOVERY_BUDGET_MS) {
    try {
      const { status, body } = await httpGet(url);
      if (status === 200 && !online.has(JSON.parse(body).pid)) {
        replacementOnline = true;
        break;
      }
    } catch {
      /* poll may land on the frozen worker — keep polling */
    }
    await sleep(POLL_INTERVAL_MS);
  }
  check("replacement serving within 15 s", replacementOnline);
  check(`total recovery < 15 s (took ${((Date.now() - t0) / 1000).toFixed(1)}s)`, Date.now() - t0 < RECOVERY_BUDGET_MS);
}

/** Boot-loop chaos: replacements crash at boot; the slot must be quarantined while the fleet serves. */
async function scenarioBootloop(fixture, check) {
  await waitForAppPort(fixture, `http://127.0.0.1:${fixture.appPort}/`);
  const online = await waitForOnline(fixture, 4);
  const alive = liveWorkerPids(fixture);
  const victim = [...online].find((pid) => alive.includes(pid));
  check("a worker pid found to kill", victim !== undefined);

  const url = `http://127.0.0.1:${fixture.appPort}/`;
  const t0 = Date.now();
  process.kill(victim, "SIGKILL");

  // From just after the kill, every poll must be served by a healthy worker:
  // the boot-looping slot must never take the rest of the fleet down.
  let servingFailedAfterSettle = null;
  let quarantined = null;
  while (quarantined === null && Date.now() - t0 < 20_000) {
    if (Date.now() - t0 > SETTLE_MS) {
      try {
        const { status } = await httpGet(url);
        if (status !== 200 && servingFailedAfterSettle === null) servingFailedAfterSettle = `status ${status}`;
      } catch (err) {
        if (servingFailedAfterSettle === null) {
          servingFailedAfterSettle = err instanceof Error ? err.message : String(err);
        }
      }
    }
    quarantined = fixture.events.find((e) => e.event === "worker:quarantined") ?? null;
    await sleep(POLL_INTERVAL_MS);
  }
  check("worker:quarantined emitted", quarantined !== null);
  check(
    "quarantined after exactly 2 consecutive boot failures",
    quarantined !== null && quarantined.consecutiveBootFailures === 2,
    `payload=${JSON.stringify(quarantined)}`,
  );
  check(
    "exactly 2 crash-at-boot forks",
    fixture.events.filter((e) => e.event === "worker:restart").length === 2,
    `restarts=${fixture.events.filter((e) => e.event === "worker:restart").length}`,
  );
  // 3 SIGKILL crashes total: the runner's kill plus the 2 killed-in-boot replacements.
  check(
    "boot failures were killed-in-boot workers (never online)",
    fixture.events.filter((e) => e.event === "worker:crash" && e.code === null && e.signal === "SIGKILL").length === 3,
  );
  check(
    "healthy workers kept serving through the boot loop",
    servingFailedAfterSettle === null,
    servingFailedAfterSettle ?? "",
  );

  // A quarantined slot stays down: the fleet must keep serving afterwards too.
  const settleEnd = Date.now() + 2000;
  let failedAfterQuarantine = null;
  while (Date.now() < settleEnd) {
    try {
      const { status } = await httpGet(url);
      if (status !== 200 && failedAfterQuarantine === null) failedAfterQuarantine = `status ${status}`;
    } catch (err) {
      if (failedAfterQuarantine === null) failedAfterQuarantine = err instanceof Error ? err.message : String(err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  check("fleet still serving 2 s after quarantine", failedAfterQuarantine === null, failedAfterQuarantine ?? "");
}

/** Metrics chaos: after a kill/recovery cycle the Prometheus output must expose the health metrics. */
async function scenarioMetrics(fixture, check) {
  const url = `http://127.0.0.1:${fixture.appPort}/`;
  const metricsUrl = `http://127.0.0.1:${fixture.metricsPort}/metrics`;
  await waitForAppPort(fixture, url);
  await waitForAppPort(fixture, metricsUrl);

  const baseline = await httpGet(metricsUrl);
  check(
    "clusterkit_fleet_active_workers exposed at baseline",
    baseline.body.includes("clusterkit_fleet_active_workers"),
  );

  const online = await waitForOnline(fixture, 4);
  const alive = liveWorkerPids(fixture);
  const victim = [...online].find((pid) => alive.includes(pid));
  process.kill(victim, "SIGKILL");

  // Recovery = degraded → recovered cycle reflected in the scrape output.
  const activeRe = /^clusterkit_fleet_active_workers(?:\{[^}]*\})?\s+([\d.]+)$/m;
  const recoveryRe = /^clusterkit_recovery_duration_seconds(?:\{[^}]*\})?\s+([\d.]+)$/m;
  let metrics = "";
  let recovered = false;
  const t0 = Date.now();
  while (Date.now() - t0 < RECOVERY_BUDGET_MS) {
    try {
      metrics = (await httpGet(metricsUrl)).body;
      const recovery = recoveryRe.exec(metrics);
      const active = activeRe.exec(metrics);
      if (
        recovery &&
        Number(recovery[1]) > 0 &&
        active &&
        Number(active[1]) === 4 &&
        metrics.includes("clusterkit_worker_rss_bytes")
      ) {
        recovered = true;
        break;
      }
    } catch {
      /* scrape hiccup — keep polling */
    }
    await sleep(250);
  }
  check("clusterkit_recovery_duration_seconds > 0 after recovery", recovered, metrics ? "" : "no scrape output");
  check("clusterkit_worker_rss_bytes present", metrics.includes("clusterkit_worker_rss_bytes"));
  check(
    "clusterkit_fleet_active_workers back to target",
    recovered && Number(activeRe.exec(metrics)?.[1]) === 4,
    `active=${activeRe.exec(metrics)?.[1]}`,
  );
  for (const name of [
    "clusterkit_worker_heap_used_bytes",
    "clusterkit_worker_eventloop_lag_ms",
    "clusterkit_worker_heartbeat_age_seconds",
    "clusterkit_fleet_target_workers",
    "clusterkit_fleet_quarantined_slots",
  ]) {
    check(`${name} present`, metrics.includes(name));
  }
}

// ============================================================================
// Harness
// ============================================================================

async function runScenario(name, appPort, metricsPort, fn) {
  const fixture = startFixture(name, appPort, metricsPort);
  fixture.metricsPort = metricsPort;
  const checks = [];
  const check = (label, ok, detail = "") => checks.push({ label, ok, detail });
  const t0 = Date.now();
  try {
    await fn(fixture, check);
  } catch (err) {
    check("scenario completed without harness error", false, err instanceof Error ? err.message : String(err));
  } finally {
    await stopFixture(fixture.child);
    rmSync(fixture.stateDir, { recursive: true, force: true });
  }
  return { name, checks, durationMs: Date.now() - t0, fixture };
}

async function main() {
  console.log("chaos e2e — worker health & recovery");
  const scenarios = [
    ["kill", scenarioKill],
    ["wedge", scenarioWedge],
    ["bootloop", scenarioBootloop],
    ["metrics", scenarioMetrics],
  ];
  const results = [];
  for (const [name, fn] of scenarios) {
    process.stdout.write(`running scenario ${name}... `);
    const appPort = await getFreePort();
    const metricsPort = name === "metrics" ? await getFreePort() : 0;
    const result = await runScenario(name, appPort, metricsPort, fn);
    results.push(result);
    console.log(result.checks.every((c) => c.ok) ? "ok" : "FAILED");
  }

  console.log("\n=== summary ===");
  let failed = 0;
  for (const result of results) {
    const ok = result.checks.every((c) => c.ok);
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${result.name.padEnd(10)} ${(result.durationMs / 1000).toFixed(1)}s`);
    for (const { label, ok: checkOk, detail } of result.checks) {
      console.log(`  ${checkOk ? "✓" : "✗"} ${label}${detail && !checkOk ? ` (${detail})` : ""}`);
    }
    if (!ok) {
      console.log(`  fixture stdout tail:`);
      for (const line of result.fixture.raw.slice(-45)) console.log(`    ${line}`);
      if (result.fixture.stderr.trim())
        console.log(`  fixture stderr tail:\n    ${result.fixture.stderr.trimEnd().slice(-500)}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
  // A fixture worker can outlive its primary (e.g. a frozen worker orphaned
  // by the forced exit during shutdown) and hold the write end of an
  // inherited stdio pipe — the event loop would never drain. Exit explicitly
  // once the summary is flushed.
  for (const result of results) {
    result.fixture.child.stdout?.destroy();
    result.fixture.child.stderr?.destroy();
  }
  process.stdout.write("", () => process.exit(failed > 0 ? 1 : 0));
}

await main();
