import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      quick: { type: "boolean", default: false },
      target: { type: "string" },
      workload: { type: "string" },
      port: { type: "string", default: "3100" },
      list: { type: "boolean", default: false },
      smoke: { type: "boolean", default: false },
      "conns-per-worker": { type: "string", default: "50" },
      scenario: { type: "string" },
      health: { type: "string", default: "off" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.scenario !== undefined && values.scenario !== "recovery") {
    throw new Error(`unknown --scenario "${values.scenario}" (supported: recovery)`);
  }
  if (values.health !== "on" && values.health !== "off") {
    throw new Error(`--health must be "on" or "off" (got "${values.health}")`);
  }

  return {
    quick: values.quick,
    target: values.target,
    workload: values.workload,
    port: Number.parseInt(values.port, 10),
    list: values.list,
    smoke: values.smoke,
    connsPerWorker: Number.parseInt(values["conns-per-worker"], 10),
    scenario: values.scenario,
    health: values.health,
  };
}

export function listAvailable() {
  const targetsDir = join(__dirname, "..", "targets");
  const workloadsDir = join(__dirname, "..", "workloads");

  const targets = readdirSync(targetsDir)
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))
    .map((f) => f.replace(".mjs", ""));

  const workloads = readdirSync(workloadsDir)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => f.replace(".mjs", ""));

  console.log("Available targets:");
  for (const t of targets) console.log(`  ${t}`);
  console.log("\nAvailable workloads:");
  for (const w of workloads) console.log(`  ${w}`);
}

export function resolveConfig(cli) {
  const mode = cli.quick ? "quick" : "reference";
  const warmupSec = cli.quick ? 3 : 10;
  const measureSec = cli.quick ? 10 : 30;
  const repetitions = cli.quick ? 1 : 3;

  return {
    mode,
    warmupSec,
    measureSec,
    repetitions,
    connsPerWorker: cli.connsPerWorker,
    port: cli.port,
  };
}
