import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packages = [
  "@goopil/clusterkit",
  "@goopil/clusterkit-prometheus",
  "@goopil/clusterkit-sizing",
  "@goopil/clusterkit-otlp-meter",
];

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: rootDir, stdio: "inherit", ...options });
}

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), "clusterkit-package-smoke-"));
  const tarballsDir = join(tempDir, "tarballs");
  const consumerDir = join(tempDir, "consumer");

  try {
    run("corepack", ["pnpm", "build"]);

    for (const packageName of packages) {
      run("corepack", ["pnpm", "--filter", packageName, "pack", "--pack-destination", tarballsDir]);
    }

    const tarballs = await readdir(tarballsDir);
    const dependencies = Object.fromEntries(
      packages.map((packageName) => {
        const tarball = tarballs.find((name) => name.startsWith(`${packageName.replace("@goopil/", "goopil-")}-`));
        if (!tarball) throw new Error(`Missing tarball for ${packageName}`);
        return [packageName, `file:${join(tarballsDir, tarball)}`];
      }),
    );

    await mkdir(consumerDir);
    await writeFile(
      join(consumerDir, "package.json"),
      `${JSON.stringify(
        {
          name: "clusterkit-package-smoke",
          private: true,
          type: "module",
          dependencies,
          devDependencies: { "@types/node": "^22.12.0" },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(consumerDir, "esm.mjs"),
      `import { Orchestrator } from "@goopil/clusterkit";
import { createPrometheusPlugin } from "@goopil/clusterkit-prometheus";
import { createContainerSizingPlugin } from "@goopil/clusterkit-sizing";
import { createOtlpMeterPlugin } from "@goopil/clusterkit-otlp-meter";

if (!(new Orchestrator() instanceof Orchestrator)) throw new Error("ESM core import failed");
if (createPrometheusPlugin().name !== "prometheus") throw new Error("ESM Prometheus import failed");
if (createContainerSizingPlugin().name !== "container-sizing") throw new Error("ESM sizing import failed");
if (createOtlpMeterPlugin({ instrumentation: false }).name !== "otlp-meter") throw new Error("ESM OTLP import failed");
`,
    );
    await writeFile(
      join(consumerDir, "cjs.cjs"),
      `const { Orchestrator } = require("@goopil/clusterkit");
const { createPrometheusPlugin } = require("@goopil/clusterkit-prometheus");
const { createContainerSizingPlugin } = require("@goopil/clusterkit-sizing");
const { createOtlpMeterPlugin } = require("@goopil/clusterkit-otlp-meter");

if (!(new Orchestrator() instanceof Orchestrator)) throw new Error("CJS core import failed");
if (createPrometheusPlugin().name !== "prometheus") throw new Error("CJS Prometheus import failed");
if (createContainerSizingPlugin().name !== "container-sizing") throw new Error("CJS sizing import failed");
if (createOtlpMeterPlugin({ instrumentation: false }).name !== "otlp-meter") throw new Error("CJS OTLP import failed");
`,
    );
    await writeFile(
      join(consumerDir, "index.ts"),
      `import { Orchestrator, type OrchestratorPlugin } from "@goopil/clusterkit";
import { createPrometheusPlugin, type PrometheusPlugin } from "@goopil/clusterkit-prometheus";
import { createContainerSizingPlugin, type ContainerSizingPlugin } from "@goopil/clusterkit-sizing";

const orchestrator = new Orchestrator();
const plugins: OrchestratorPlugin[] = [createPrometheusPlugin(), createContainerSizingPlugin()];
const prometheusPlugin: PrometheusPlugin = createPrometheusPlugin();
const sizingPlugin: ContainerSizingPlugin = createContainerSizingPlugin();

void orchestrator;
void plugins;
void prometheusPlugin;
void sizingPlugin;
`,
    );
    await writeFile(
      join(consumerDir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            strict: true,
            types: ["node"],
          },
        },
        null,
        2,
      )}\n`,
    );

    run("corepack", ["pnpm", "--dir", consumerDir, "install", "--ignore-scripts"]);
    run(process.execPath, [join(consumerDir, "esm.mjs")]);
    run(process.execPath, [join(consumerDir, "cjs.cjs")]);
    run("corepack", [
      "pnpm",
      "--filter",
      "@goopil/clusterkit",
      "exec",
      "tsc",
      "--project",
      join(consumerDir, "tsconfig.json"),
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
