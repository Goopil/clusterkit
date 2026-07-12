import os from "node:os";
import type { CgroupLimits } from "@goopil/clusterkit";

export type SizingStrategy = "balanced" | "memory-first" | "cpu-first";

export interface SizingOptions {
  /**
   * Fraction of the container memory considered usable (the rest is headroom for OS/native).
   * @default 0.80
   */
  memoryOverheadFactor?: number;
  /**
   * Fraction of per-worker memory allocated to the V8 old-generation heap (--max-old-space-size).
   * The remainder covers V8 metadata, native heap, buffers and stack.
   * @default 0.75
   */
  heapRatio?: number;
  /** @default 1 */
  minWorkers?: number;
  /** @default 64 */
  maxWorkers?: number;
  /**
   * - `balanced`     — workers = floor(cpu), reduced when each would get less
   *                    than 128 MB of V8 heap (default)
   * - `memory-first` — same reduction as `balanced`; kept as an explicit alias
   * - `cpu-first`    — always workers = floor(cpu); the heap is clamped to the
   *                    128 MB viability floor, which may over-commit memory
   */
  strategy?: SizingStrategy;
}

export interface SizingResult {
  workers: number;
  /** Total container memory divided by workers, after overhead factor. */
  memoryPerWorkerMb: number;
  /** Value passed to --max-old-space-size (heapRatio × memoryPerWorkerMb). */
  v8HeapMb: number;
  /**
   * True when the computed heap fell below the 128 MB viability floor and was
   * clamped up to it — the container memory is over-committed and workers may
   * be OOM-killed under load.
   */
  constrained: boolean;
  /** Ready-to-inject NODE_OPTIONS fragment. */
  nodeOptions: string;
  source: {
    cpuLimit: number | null;
    memoryLimitBytes: number | null;
    osCpus: number;
    osTotalMemoryBytes: number;
  };
}

const MIN_VIABLE_HEAP_MB = 128;
const MAX_REASONABLE_WORKERS = 256;

function assertFraction(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError(`${field} must be a finite number in the (0, 1] range`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer`);
  }
}

export function validateSizingOptions(options: SizingOptions = {}): void {
  const { memoryOverheadFactor = 0.8, heapRatio = 0.75, minWorkers = 1, maxWorkers = 64 } = options;

  assertFraction(memoryOverheadFactor, "memoryOverheadFactor");
  assertFraction(heapRatio, "heapRatio");
  assertPositiveInteger(minWorkers, "minWorkers");
  assertPositiveInteger(maxWorkers, "maxWorkers");
  if (minWorkers > MAX_REASONABLE_WORKERS) {
    throw new RangeError(`minWorkers must be less than or equal to ${MAX_REASONABLE_WORKERS}`);
  }
  if (maxWorkers > MAX_REASONABLE_WORKERS) {
    throw new RangeError(`maxWorkers must be less than or equal to ${MAX_REASONABLE_WORKERS}`);
  }
  if (minWorkers > maxWorkers) {
    throw new RangeError("minWorkers must be less than or equal to maxWorkers");
  }
}

export function calculateSizing(limits: CgroupLimits, options: SizingOptions = {}): SizingResult {
  const {
    memoryOverheadFactor = 0.8,
    heapRatio = 0.75,
    minWorkers = 1,
    maxWorkers = 64,
    strategy = "balanced",
  } = options;

  validateSizingOptions(options);

  // availableParallelism respects cpuset/affinity (K8s static CPU policy),
  // unlike os.cpus().length which reports all host cores.
  const osCpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const osTotalMemoryBytes = os.totalmem();

  const effectiveCpu = limits.cpuLimit ?? osCpus;
  const effectiveMemory = limits.memoryLimitBytes ?? osTotalMemoryBytes;

  let workers = Math.max(minWorkers, Math.min(maxWorkers, Math.floor(effectiveCpu)));

  if (strategy !== "cpu-first") {
    // Step down workers until each gets at least MIN_VIABLE_HEAP_MB of V8 heap
    while (workers > minWorkers) {
      const heapMb = Math.floor(((effectiveMemory * memoryOverheadFactor) / workers / (1024 * 1024)) * heapRatio);
      if (heapMb >= MIN_VIABLE_HEAP_MB) break;
      workers--;
    }
  }

  const memoryPerWorkerMb = Math.floor((effectiveMemory * memoryOverheadFactor) / workers / (1024 * 1024));
  const rawV8HeapMb = Math.floor(memoryPerWorkerMb * heapRatio);

  // Never emit a sub-viable value: --max-old-space-size=0 (or a tiny heap)
  // makes V8 fall back to its ~4 GB default ceiling — the memory limit would
  // silently vanish exactly when memory is scarcest.
  const v8HeapMb = Math.max(rawV8HeapMb, MIN_VIABLE_HEAP_MB);
  const constrained = rawV8HeapMb < MIN_VIABLE_HEAP_MB;

  return {
    workers,
    memoryPerWorkerMb,
    v8HeapMb,
    constrained,
    nodeOptions: `--max-old-space-size=${v8HeapMb}`,
    source: {
      cpuLimit: limits.cpuLimit,
      memoryLimitBytes: limits.memoryLimitBytes,
      osCpus,
      osTotalMemoryBytes,
    },
  };
}

/**
 * Merges the computed NODE_OPTIONS fragment with any pre-existing value from the environment,
 * removing a prior --max-old-space-size if present to avoid conflicts.
 * Node accepts dash and underscore spellings and `--flag value` syntax; all
 * must be stripped because the LAST occurrence wins over the computed value.
 */
export function mergeNodeOptions(computed: string, existing: string, extra?: string): string {
  const cleaned = existing
    .replace(/--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return [computed, cleaned, extra].filter(Boolean).join(" ").trim();
}
