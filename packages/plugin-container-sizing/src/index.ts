import cluster from "node:cluster";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Logger,
  type Orchestrator,
  type ResolvedConfig,
  readCgroupLimits,
  withLoggerPrefix,
} from "@goopil/clusterkit";
import { calculateSizing, mergeNodeOptions, validateSizingOptions } from "./calculator.js";
import type { ContainerSizingOptions, ContainerSizingPlugin } from "./types.js";

export type { SizingOptions, SizingResult, SizingStrategy } from "./calculator.js";
export type { CgroupLimits, ContainerSizingOptions, ContainerSizingPlugin } from "./types.js";
export { mergeNodeOptions, validateSizingOptions };

export function createContainerSizingPlugin(options: ContainerSizingOptions = {}): ContainerSizingPlugin {
  const {
    overrideWorkerCount = true,
    injectNodeOptions = true,
    extraNodeOptions,
    compileCache,
    fallback = true,
    ...sizingOptions
  } = options;

  let sizing: import("./calculator.js").SizingResult | undefined;

  return {
    name: "container-sizing",

    get sizing() {
      return sizing;
    },

    async install(orchestrator: Orchestrator, logger: Logger | null, config: ResolvedConfig): Promise<void> {
      if (!cluster.isPrimary) return;

      const log = withLoggerPrefix(logger, "clusterkit:sizing");

      const limits = await readCgroupLimits();
      const hasContainerLimits = limits.cpuLimit !== null || limits.memoryLimitBytes !== null;

      if (!hasContainerLimits && !fallback) {
        log?.info("No container limits detected — skipping (fallback disabled)");
        return;
      }

      if (!hasContainerLimits) {
        log?.info("No container limits detected, using OS resources as fallback");
      }

      sizing = calculateSizing(limits, sizingOptions);

      const limitSource = hasContainerLimits ? "cgroup" : "os-fallback";
      log?.info("Sizing computed", {
        source: limitSource,
        cpuLimit: limits.cpuLimit,
        memoryLimitMb: limits.memoryLimitBytes !== null ? Math.round(limits.memoryLimitBytes / 1024 / 1024) : null,
        workers: sizing.workers,
        memoryPerWorkerMb: sizing.memoryPerWorkerMb,
        v8HeapMb: sizing.v8HeapMb,
        nodeOptions: sizing.nodeOptions,
      });

      if (sizing.constrained) {
        log?.warn("Container memory is too small for the computed worker count — heap clamped to the viability floor", {
          workers: sizing.workers,
          v8HeapMb: sizing.v8HeapMb,
          memoryPerWorkerMb: sizing.memoryPerWorkerMb,
        });
      }

      if (overrideWorkerCount) {
        if (config.workers.count === "auto") {
          orchestrator.overrideWorkerCount(sizing.workers);
        } else {
          log?.info("Worker count explicitly configured — skipping override", {
            configured: config.workers.count,
            computed: sizing.workers,
          });
        }
      }

      const env: NodeJS.ProcessEnv = {};

      if (injectNodeOptions) {
        // Prefer workerEnv.NODE_OPTIONS (explicitly set by the user in config) over process.env,
        // so we only replace --max-old-space-size and leave every other flag intact.
        const baseNodeOptions = config.workers.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? "";
        env.NODE_OPTIONS = mergeNodeOptions(sizing.nodeOptions, baseNodeOptions, extraNodeOptions);
      }

      if (compileCache) {
        // Env-only setting: NODE_COMPILE_CACHE is a plain env var, not a CLI flag.
        env.NODE_COMPILE_CACHE =
          typeof compileCache === "string" ? compileCache : join(tmpdir(), "clusterkit-compile-cache");
      }

      if (Object.keys(env).length > 0) {
        orchestrator.patchWorkerEnv(env);
      }
    },
  };
}
