import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packages = [
  "packages/worker-manager",
  "packages/plugin-container-sizing",
  "packages/plugin-prometheus",
];
const dryRun = process.argv.includes("--dry-run");
const tarballsDirectory = mkdtempSync(join(tmpdir(), "clusterkit-publish-"));

function run(command, argumentsList) {
  execFileSync(command, argumentsList, { stdio: "inherit" });
}

function isPublished(packageName, version) {
  const result = spawnSync("npm", ["view", `${packageName}@${version}`, "version", "--json"], {
    stdio: "ignore",
  });

  if (result.error) {
    throw result.error;
  }

  return result.status === 0;
}

try {
  for (const directory of packages) {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

    if (!dryRun && isPublished(manifest.name, manifest.version)) {
      console.log(`Skipping ${manifest.name}@${manifest.version}; already published.`);
      continue;
    }

    const tarballsBeforePack = new Set(readdirSync(tarballsDirectory));
    run("pnpm", ["--filter", manifest.name, "pack", "--pack-destination", tarballsDirectory]);

    const tarballs = readdirSync(tarballsDirectory).filter(
      (fileName) => fileName.endsWith(".tgz") && !tarballsBeforePack.has(fileName),
    );

    if (tarballs.length !== 1) {
      throw new Error(`Expected one tarball for ${manifest.name}, found ${tarballs.length}.`);
    }

    const tarballPath = join(tarballsDirectory, tarballs[0]);

    if (dryRun) {
      console.log(`[dry-run] npm publish ${tarballPath} --access public --provenance`);
      continue;
    }

    run("npm", ["publish", tarballPath, "--access", "public", "--provenance"]);
  }
} finally {
  rmSync(tarballsDirectory, { force: true, recursive: true });
}
