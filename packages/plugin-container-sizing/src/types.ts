import type { OrchestratorPlugin } from "@goopil/clusterkit";
import type { SizingResult } from "./calculator.js";

export interface ContainerSizingOptions {
  /**
   * Fraction of container memory considered usable.
   * @default 0.80
   */
  memoryOverheadFactor?: number;
  /**
   * Fraction of per-worker memory allocated to the V8 heap (--max-old-space-size).
   * @default 0.75
   */
  heapRatio?: number;
  /** @default 1 */
  minWorkers?: number;
  /** @default 64 */
  maxWorkers?: number;
  /** @default 'balanced' */
  strategy?: "balanced" | "cpu-first";
  /**
   * Override the orchestrator's worker count when set to 'auto'.
   * Has no effect when workers is set to an explicit number in OrchestratorConfig.
   * @default true
   */
  overrideWorkerCount?: boolean;
  /**
   * Inject --max-old-space-size into NODE_OPTIONS for each worker.
   * @default true
   */
  injectNodeOptions?: boolean;
  /**
   * Additional NODE_OPTIONS flags appended after the computed --max-old-space-size.
   * @example '--expose-gc'
   */
  extraNodeOptions?: string;
  /**
   * Enable Node's compile cache (NODE_COMPILE_CACHE) in workers.
   * - true   — use `<tmpdir>/clusterkit-compile-cache`
   * - string — use the given directory verbatim
   * Injected as a direct env var, never through NODE_OPTIONS.
   * @default false
   */
  compileCache?: boolean | string;
  /**
   * When no container limits are detected (non-Linux or no cgroup limits):
   * - true  — fall back to os.cpus() and os.totalmem() (plugin still applies)
   * - false — skip the plugin entirely (no-op)
   * @default true
   */
  fallback?: boolean;
}

export interface ContainerSizingPlugin extends OrchestratorPlugin {
  /** The computed sizing plan. Populated after install(), undefined before. */
  readonly sizing: SizingResult | undefined;
}

export type { CgroupLimits } from "@goopil/clusterkit";
