import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix as path } from "node:path";

interface ProcCgroupEntry {
  controllers: string[];
  path: string;
}

function parseProcSelfCgroup(raw: string): ProcCgroupEntry[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [_, controllers = "", ...pathParts] = line.split(":");
      return {
        controllers: controllers ? controllers.split(",") : [],
        path: pathParts.join(":") || "/",
      };
    });
}

function normalizeCgroupPath(cgroupPath: string): string {
  return cgroupPath.replace(/^\/+/, "");
}

function buildCandidatePath(root: string, cgroupPath: string | null, fileName: string): string | null {
  const normalized = cgroupPath ? normalizeCgroupPath(cgroupPath) : "";
  const joined = normalized ? path.join(root, normalized, fileName) : path.join(root, fileName);
  const resolvedRoot = path.resolve(root);
  const resolvedJoined = path.resolve(joined);
  if (resolvedJoined !== resolvedRoot && !resolvedJoined.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return resolvedJoined;
}

function buildCandidatePaths(
  root: string,
  cgroupPath: string | null,
  fileName: string,
  fallbackPath: string,
): string[] {
  const candidates: string[] = [];
  const primary = buildCandidatePath(root, cgroupPath, fileName);
  if (primary !== null) candidates.push(primary);
  candidates.push(fallbackPath);
  return candidates;
}

function getV2ProcessPath(entries: ProcCgroupEntry[]): string | null {
  return entries.find((entry) => entry.controllers.length === 0)?.path ?? null;
}

function getV1ControllerPath(entries: ProcCgroupEntry[], controller: string): string | null {
  return entries.find((entry) => entry.controllers.includes(controller))?.path ?? null;
}

function tryReadFirstSync(paths: string[]): string | null {
  for (const candidatePath of paths) {
    try {
      return readFileSync(candidatePath, "utf8").trim();
    } catch {
      /* try next candidate */
    }
  }

  return null;
}

function parseCgroupV2Cpu(raw: string, floorToAtLeastOne: boolean): number | null {
  const [quotaStr, periodStr] = raw.split(" ");
  if (quotaStr === "max") return null;

  const quota = Number.parseInt(quotaStr, 10);
  const period = Number.parseInt(periodStr, 10);
  if (Number.isNaN(quota) || Number.isNaN(period) || period === 0) return null;

  const cpuLimit = quota / period;
  return floorToAtLeastOne ? Math.max(1, Math.floor(cpuLimit)) : cpuLimit;
}

function parseCgroupV1Cpu(quotaRaw: string, periodRaw: string, floorToAtLeastOne: boolean): number | null {
  const quota = Number.parseInt(quotaRaw, 10);
  if (quota === -1) return null; // unlimited

  const period = Number.parseInt(periodRaw, 10);
  if (Number.isNaN(quota) || Number.isNaN(period) || period === 0) return null;

  const cpuLimit = quota / period;
  return floorToAtLeastOne ? Math.max(1, Math.floor(cpuLimit)) : cpuLimit;
}

function parseCgroupV2Memory(raw: string): number | null {
  if (raw === "max") return null;

  const bytes = Number.parseInt(raw, 10);
  return Number.isNaN(bytes) ? null : bytes;
}

function parseCgroupV1Memory(raw: string): number | null {
  try {
    const bytes = BigInt(raw);
    if (bytes >= V1_UNLIMITED_THRESHOLD) return null;
    return Number(bytes);
  } catch {
    return null;
  }
}

function readProcSelfCgroupSync(): ProcCgroupEntry[] {
  try {
    return parseProcSelfCgroup(readFileSync("/proc/self/cgroup", "utf8").trim());
  } catch {
    return [];
  }
}

async function readProcSelfCgroupAsync(): Promise<ProcCgroupEntry[]> {
  const raw = await tryRead("/proc/self/cgroup");
  return raw ? parseProcSelfCgroup(raw) : [];
}

// ============================================================================
// Sync API (used by worker-manager core for synchronous os.cpus() fallback)
// ============================================================================

/**
 * Reads the CPU limit imposed by cgroup (v1 or v2).
 * Returns the number of CPUs allowed (floored to at least 1), or `null`
 * when no limit applies (non-Linux, unlimited quota, or missing files).
 */
export function getCgroupCpuLimit(): number | null {
  if (process.platform !== "linux") return null;

  // cgroup v2: /sys/fs/cgroup/cpu.max → "quota period" or "max period"
  const v2 = readCgroupV2Sync();
  if (v2 !== null) return v2;

  // cgroup v1: quota / period
  return readCgroupV1Sync();
}

function readCgroupV2Sync(): number | null {
  const entries = readProcSelfCgroupSync();
  const raw = tryReadFirstSync(
    buildCandidatePaths("/sys/fs/cgroup", getV2ProcessPath(entries), "cpu.max", "/sys/fs/cgroup/cpu.max"),
  );
  if (!raw) return null;

  return parseCgroupV2Cpu(raw, true);
}

function readCgroupV1Sync(): number | null {
  const entries = readProcSelfCgroupSync();
  const cpuPath = getV1ControllerPath(entries, "cpu");
  const quotaRaw = tryReadFirstSync(
    buildCandidatePaths("/sys/fs/cgroup/cpu", cpuPath, "cpu.cfs_quota_us", "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
  );
  if (!quotaRaw) return null;

  const periodRaw = tryReadFirstSync(
    buildCandidatePaths("/sys/fs/cgroup/cpu", cpuPath, "cpu.cfs_period_us", "/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
  );
  if (!periodRaw) return null;

  return parseCgroupV1Cpu(quotaRaw, periodRaw, true);
}

// ============================================================================
// Async API (used by plugin-container-sizing)
// ============================================================================

export interface CgroupLimits {
  /** Fractional CPU count allowed by the container (e.g. 2.5), or null when unlimited / non-Linux. */
  cpuLimit: number | null;
  /** Memory limit in bytes, or null when unlimited / non-Linux. */
  memoryLimitBytes: number | null;
}

// cgroupv1 uses this near-LLONG_MAX sentinel to mean "no limit"
const V1_MEMORY_UNLIMITED = 9_223_372_036_854_771_712n;
const V1_UNLIMITED_THRESHOLD = V1_MEMORY_UNLIMITED - 4096n;

async function tryRead(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

async function tryReadFirst(paths: string[]): Promise<string | null> {
  for (const candidatePath of paths) {
    const raw = await tryRead(candidatePath);
    if (raw !== null) return raw;
  }

  return null;
}

async function readV2Cpu(): Promise<number | null> {
  const entries = await readProcSelfCgroupAsync();
  const raw = await tryReadFirst(
    buildCandidatePaths("/sys/fs/cgroup", getV2ProcessPath(entries), "cpu.max", "/sys/fs/cgroup/cpu.max"),
  );
  if (!raw) return null;

  return parseCgroupV2Cpu(raw, false);
}

async function readV2Memory(): Promise<number | null> {
  const entries = await readProcSelfCgroupAsync();
  const raw = await tryReadFirst(
    buildCandidatePaths("/sys/fs/cgroup", getV2ProcessPath(entries), "memory.max", "/sys/fs/cgroup/memory.max"),
  );
  if (!raw) return null;

  return parseCgroupV2Memory(raw);
}

async function readV1Cpu(): Promise<number | null> {
  const entries = await readProcSelfCgroupAsync();
  const cpuPath = getV1ControllerPath(entries, "cpu");
  const quotaRaw = await tryReadFirst(
    buildCandidatePaths("/sys/fs/cgroup/cpu", cpuPath, "cpu.cfs_quota_us", "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
  );
  if (!quotaRaw) return null;

  const periodRaw = await tryReadFirst(
    buildCandidatePaths("/sys/fs/cgroup/cpu", cpuPath, "cpu.cfs_period_us", "/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
  );
  if (!periodRaw) return null;

  return parseCgroupV1Cpu(quotaRaw, periodRaw, false);
}

async function readV1Memory(): Promise<number | null> {
  const entries = await readProcSelfCgroupAsync();
  const memoryPath = getV1ControllerPath(entries, "memory");
  const raw = await tryReadFirst(
    buildCandidatePaths(
      "/sys/fs/cgroup/memory",
      memoryPath,
      "memory.limit_in_bytes",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ),
  );
  if (!raw) return null;

  return parseCgroupV1Memory(raw);
}

/**
 * Reads CPU and memory limits from the container's cgroup (v1 or v2).
 * Returns null fields when running outside Linux or when no limits are set.
 */
export async function readCgroupLimits(): Promise<CgroupLimits> {
  if (process.platform !== "linux") {
    return { cpuLimit: null, memoryLimitBytes: null };
  }

  // Presence of this file distinguishes v2 (unified hierarchy) from v1
  const isV2 = (await tryRead("/sys/fs/cgroup/cgroup.controllers")) !== null;

  const [cpuLimit, memoryLimitBytes] = await Promise.all(
    isV2 ? [readV2Cpu(), readV2Memory()] : [readV1Cpu(), readV1Memory()],
  );

  return { cpuLimit, memoryLimitBytes };
}
