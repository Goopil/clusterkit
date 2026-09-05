// E2E fixture for the worker health & recovery chaos suite (chaos.e2e.mjs).
// Plain node:http — zero app dependencies. The Orchestrator re-forks this same
// entry script for every worker; env selects the behavior under test:
//
//   CKX_SCENARIO=kill|wedge|bootloop|metrics  (set by the runner)
//   CKX_WORKER_MODE / CKX_WEDGE_BOOT_INDEX
//     (set by the fixture primary via patchWorkerEnv BEFORE run())
//
// Fork determinism: `process.pid % 2` is not deterministic, so each worker
// claims a unique boot index by atomically creating a claim file (O_EXCL) in
// CKX_STATE_DIR — first worker to boot claims 1, and exactly one worker holds
// any given index, so "fork 1 wedges" stays deterministic.

import cluster from "node:cluster";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { createConsoleLogger, Orchestrator } from "@goopil/clusterkit";

const scenario = process.env.CKX_SCENARIO ?? "kill";
const port = Number(process.env.PORT ?? 3000);
const stateDir = process.env.CKX_STATE_DIR;
const log = createConsoleLogger();

// Events the chaos runner asserts on, echoed to stdout as one JSON per line.
const ECHO_EVENTS = [
  "worker:online",
  "worker:exit",
  "worker:crash",
  "worker:restart",
  "worker:recycle",
  "worker:wedged",
  "worker:quarantined",
  "fleet:degraded",
  "fleet:recovered",
];

function buildConfig() {
  const config = {
    logger: log,
    workers: { count: 4 },
    health: { heartbeatMs: 500, degradedAfterMs: 1000 },
    restart: { backoffMs: 500 },
    // Short escalation ladder: the runner budgets 15 s per recovery and the
    // drain spends shutdown.timeoutMs before SIGTERM.
    shutdown: { timeoutMs: 2000, ackTimeoutMs: 500, sigtermDelayMs: 500, sigintDelayMs: 500 },
  };
  if (scenario === "wedge") config.health.wedgedTimeoutMs = 2000;
  if (scenario === "bootloop") {
    config.restart.bootFailQuarantine = 2;
    config.restart.backoffMs = 200;
  }
  if (scenario === "metrics") {
    // A single-worker kill recovers in ~800 ms (backoff + boot); the
    // degradation hysteresis must be shorter than that or the
    // degraded → recovered cycle never fires.
    config.health.degradedAfterMs = 100;
  }
  return config;
}

function workerEnv() {
  const env = { CKX_WORKER_MODE: "normal" };
  if (scenario === "wedge") env.CKX_WEDGE_BOOT_INDEX = "1";
  return env;
}

const orchestrator = new Orchestrator(buildConfig());

let prometheus = null;
if (scenario === "metrics") {
  // Resolved from the sibling workspace package: workspace plugins are only
  // linked into their own packages, so a bare import would not resolve from
  // worker-manager's test tree. Requires a prior workspace build.
  const pluginUrl = new URL("../../../plugin-prometheus/dist/index.mjs", import.meta.url);
  try {
    const { createPrometheusPlugin } = await import(pluginUrl.href);
    prometheus = createPrometheusPlugin({ prefix: "clusterkit_" });
  } catch (err) {
    console.error(`fixture: cannot load @goopil/clusterkit-prometheus (${err instanceof Error ? err.message : err})`);
    console.error("hint: run `corepack pnpm build` before the e2e so workspace dist output is current");
    process.exit(1);
  }
  orchestrator.use(prometheus);
}

if (cluster.isPrimary) {
  orchestrator.patchWorkerEnv(workerEnv());

  for (const event of ECHO_EVENTS) {
    orchestrator.on(event, (payload) => console.log(JSON.stringify({ event, ...payload })));
  }

  // Boot-loop chaos: kill each crash-replacement within its fork tick — the
  // worker dies before it can boot, which the orchestrator records as a real
  // boot failure (never online) and, after `bootFailQuarantine` consecutive
  // ones, quarantines the slot. (An exit(1) in worker module scope would NOT
  // count: the cluster IPC handshake completes during child bootstrap, before
  // any user code runs, so such a worker is already "online" when it exits.)
  if (scenario === "bootloop") {
    let bootKillsLeft = 2;
    orchestrator.on("worker:restart", ({ newPid }) => {
      if (bootKillsLeft <= 0) return;
      bootKillsLeft--;
      try {
        process.kill(newPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    });
  }

  if (stateDir) {
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
  }

  if (prometheus) {
    const metricsPort = Number(process.env.CKX_METRICS_PORT ?? 9100);
    const metricsServer = http.createServer(async (req, res) => {
      if (req.url !== "/metrics") {
        res.statusCode = 404;
        res.end();
        return;
      }
      try {
        res.setHeader("Content-Type", prometheus.registry.contentType);
        res.end(await prometheus.getMetrics());
      } catch (err) {
        res.statusCode = 500;
        res.end(`metrics error: ${err instanceof Error ? err.message : err}`);
      }
    });
    metricsServer.listen(metricsPort, "127.0.0.1");
    orchestrator.registerOnShutdown(() => metricsServer.close());
    console.log(JSON.stringify({ event: "fixture:ready", metricsPort }));
  }
}

await orchestrator.run(() => {
  if (!cluster.isWorker) return;

  // Claim a unique boot index (fork N) — the deterministic behavior key.
  let bootIndex = 1;
  while (stateDir) {
    try {
      closeSync(openSync(join(stateDir, `claim-${bootIndex}`), "wx"));
      break;
    } catch {
      bootIndex++;
    }
  }

  const server = http.createServer((_req, res) => {
    res.end(JSON.stringify({ pid: process.pid }));
  });

  // Wedge chaos: the fork-N worker freezes its event loop (without burning
  // CPU) after 2 s — the heartbeat stops and wedged detection must escalate
  // the drain to SIGKILL, since the worker can no longer ACK anything.
  const wedgeIndex = Number(process.env.CKX_WEDGE_BOOT_INDEX ?? 0);
  if (wedgeIndex > 0 && bootIndex === wedgeIndex) {
    setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0), 2_000).unref();
  }

  server.listen({ port, host: "127.0.0.1", reusePort: true });
  orchestrator.registerOnShutdown(() => server.close());
});
