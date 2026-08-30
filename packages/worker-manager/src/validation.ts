import type { OrchestratorConfig, ResolvedConfig, RestartConfig, ShutdownConfig, WorkersConfig } from "./types";

// ============================================================================
// Error
// ============================================================================

export class WorkerManagerValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`Invalid option '${field}': ${message}`);
    this.name = "WorkerManagerValidationError";
    Error.captureStackTrace?.(this, WorkerManagerValidationError);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function assertRange(val: unknown, field: string, min: number, max: number): void {
  if (!Number.isFinite(val) || (val as number) < min || (val as number) > max) {
    const maxStr = max === Infinity ? "+∞" : String(max);
    throw new WorkerManagerValidationError(field, `must be a finite number between ${min} and ${maxStr} (got ${val})`);
  }
}

function assertPositiveInteger(val: unknown, field: string): void {
  if (!Number.isInteger(val) || (val as number) < 1) {
    throw new WorkerManagerValidationError(field, `must be a positive integer >= 1 (got ${val})`);
  }
}

function assertPlainObject(val: unknown, field: string): void {
  if (val === undefined) {
    return;
  }
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    throw new WorkerManagerValidationError(field, "must be a plain object");
  }
}

// ============================================================================
// Sub-validators
// ============================================================================

const DANGEROUS_ARG_PATTERNS = [
  /^--require(?:[=\s]|$)/,
  /^--eval(?:[=\s]|$)/,
  /^--print(?:[=\s]|$)/,
  /^--inspect(?:-brk|-port|[=\s]|$)/,
  /^--import(?:[=\s]|$)/,
  /^--(?:experimental-)?loader(?:[=\s]|$)/,
  /^-r(?:$|\s)/,
  /^-e(?:$|\s)/,
  /^-p(?:$|\s)/,
];

function validateWorkersOptions(workers: WorkersConfig): void {
  if (workers.count !== undefined && workers.count !== "auto") {
    assertPositiveInteger(workers.count, "workers.count");
  }
  if (workers.maxAgeMs !== undefined && workers.maxAgeMs !== 0) {
    assertRange(workers.maxAgeMs, "workers.maxAgeMs", 1_000, Infinity);
  }
  if (workers.env !== undefined && (typeof workers.env !== "object" || Array.isArray(workers.env))) {
    throw new WorkerManagerValidationError("workers.env", "must be a plain object");
  }
  if (workers.execArgv !== undefined) {
    if (!Array.isArray(workers.execArgv)) {
      throw new WorkerManagerValidationError("workers.execArgv", "must be an array of strings");
    }
    const hasInvalidArg = workers.execArgv.some((arg) => typeof arg !== "string" || !arg.trim());
    if (hasInvalidArg) {
      throw new WorkerManagerValidationError("workers.execArgv", "must contain only non-empty strings");
    }
    const dangerousArg = workers.execArgv.find((arg) => DANGEROUS_ARG_PATTERNS.some((p) => p.test(arg.trim())));
    if (dangerousArg) {
      throw new WorkerManagerValidationError(
        "workers.execArgv",
        `contains a potentially dangerous flag '${dangerousArg}' (--require, --eval, --inspect, etc. are blocked)`,
      );
    }
  }
}

function validateRestartOptions(restart: RestartConfig): void {
  if (restart.crashThreshold !== undefined) {
    assertPositiveInteger(restart.crashThreshold, "restart.crashThreshold");
  }
  if (restart.crashWindowMs !== undefined) {
    assertRange(restart.crashWindowMs, "restart.crashWindowMs", 1_000, 600_000);
  }
  if (restart.backoffMs !== undefined) {
    assertRange(restart.backoffMs, "restart.backoffMs", 0, 60_000);
  }
  if (restart.maxBackoffMs !== undefined) {
    assertRange(restart.maxBackoffMs, "restart.maxBackoffMs", 1_000, 300_000);
  }
  if (restart.backoffMultiplier !== undefined) {
    assertRange(restart.backoffMultiplier, "restart.backoffMultiplier", 1, 10);
  }
  if (restart.stabilityWindowMs !== undefined) {
    assertRange(restart.stabilityWindowMs, "restart.stabilityWindowMs", 0, 600_000);
  }
}

function validateShutdownOptions(shutdown: ShutdownConfig): void {
  if (shutdown.timeoutMs !== undefined) {
    assertRange(shutdown.timeoutMs, "shutdown.timeoutMs", 1_000, 60_000);
  }
  if (shutdown.ackTimeoutMs !== undefined) {
    assertRange(shutdown.ackTimeoutMs, "shutdown.ackTimeoutMs", 500, 30_000);
  }
  if (shutdown.sigtermDelayMs !== undefined) {
    assertRange(shutdown.sigtermDelayMs, "shutdown.sigtermDelayMs", 100, 10_000);
  }
  if (shutdown.sigintDelayMs !== undefined) {
    assertRange(shutdown.sigintDelayMs, "shutdown.sigintDelayMs", 100, 10_000);
  }
  if (shutdown.messagePrefix !== undefined) {
    if (typeof shutdown.messagePrefix !== "string" || !shutdown.messagePrefix.trim()) {
      throw new WorkerManagerValidationError("shutdown.messagePrefix", "must be a non-empty string");
    }
    if (shutdown.messagePrefix.includes(":")) {
      throw new WorkerManagerValidationError("shutdown.messagePrefix", "must not contain ':' (reserved separator)");
    }
  }
}

function validateCrossFieldConstraints(resolved: ResolvedConfig): void {
  const totalKillDelay = resolved.shutdown.sigtermDelayMs + resolved.shutdown.sigintDelayMs;
  if (totalKillDelay >= resolved.shutdown.timeoutMs) {
    throw new WorkerManagerValidationError(
      "shutdown.timeoutMs",
      `must be greater than shutdown.sigtermDelayMs + shutdown.sigintDelayMs (${totalKillDelay}ms)`,
    );
  }
  if (resolved.shutdown.ackTimeoutMs >= resolved.shutdown.timeoutMs) {
    throw new WorkerManagerValidationError(
      "shutdown.ackTimeoutMs",
      `must be less than shutdown.timeoutMs (${resolved.shutdown.timeoutMs}ms)`,
    );
  }
  if (resolved.restart.backoffMs > resolved.restart.maxBackoffMs) {
    throw new WorkerManagerValidationError(
      "restart.maxBackoffMs",
      `must be greater than or equal to restart.backoffMs (${resolved.restart.backoffMs}ms)`,
    );
  }
}

// ============================================================================
// Validate + apply defaults
// ============================================================================

const DEFAULTS = {
  logger: null,
  workers: {
    count: "auto" as const,
    env: undefined,
    execArgv: undefined,
    maxAgeMs: 0,
  },
  restart: {
    crashThreshold: 5,
    crashWindowMs: 60_000,
    backoffMs: 1_000,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2,
    stabilityWindowMs: 30_000,
  },
  shutdown: {
    timeoutMs: 12_000,
    ackTimeoutMs: 3_000,
    messagePrefix: "__wm",
    sigtermDelayMs: 2_000,
    sigintDelayMs: 1_000,
  },
  clusterModule: undefined,
} satisfies ResolvedConfig;

const ALLOWED_ROOT_KEYS = new Set(["logger", "workers", "restart", "shutdown", "clusterModule"]);

export function validateConfig(config: OrchestratorConfig = {}): ResolvedConfig {
  const configRecord = config as Record<string, unknown>;
  const unsupportedField = Object.keys(configRecord).find((key) => !ALLOWED_ROOT_KEYS.has(key));
  if (unsupportedField) {
    throw new WorkerManagerValidationError(unsupportedField, "is not a supported option");
  }

  assertPlainObject(config.workers, "workers");
  assertPlainObject(config.restart, "restart");
  assertPlainObject(config.shutdown, "shutdown");

  const workers = config.workers ?? {};
  const restart = config.restart ?? {};
  const shutdown = config.shutdown ?? {};

  validateWorkersOptions(workers);
  validateRestartOptions(restart);
  validateShutdownOptions(shutdown);

  const resolvedConfig: ResolvedConfig = {
    logger: config.logger ?? DEFAULTS.logger,
    clusterModule: config.clusterModule,
    workers: {
      count: workers.count ?? DEFAULTS.workers.count,
      env: workers.env ?? DEFAULTS.workers.env,
      execArgv: workers.execArgv ?? DEFAULTS.workers.execArgv,
      maxAgeMs: workers.maxAgeMs ?? DEFAULTS.workers.maxAgeMs,
    },
    restart: {
      crashThreshold: restart.crashThreshold ?? DEFAULTS.restart.crashThreshold,
      crashWindowMs: restart.crashWindowMs ?? DEFAULTS.restart.crashWindowMs,
      backoffMs: restart.backoffMs ?? DEFAULTS.restart.backoffMs,
      maxBackoffMs: restart.maxBackoffMs ?? DEFAULTS.restart.maxBackoffMs,
      backoffMultiplier: restart.backoffMultiplier ?? DEFAULTS.restart.backoffMultiplier,
      stabilityWindowMs: restart.stabilityWindowMs ?? DEFAULTS.restart.stabilityWindowMs,
    },
    shutdown: {
      timeoutMs: shutdown.timeoutMs ?? DEFAULTS.shutdown.timeoutMs,
      ackTimeoutMs: shutdown.ackTimeoutMs ?? DEFAULTS.shutdown.ackTimeoutMs,
      messagePrefix: shutdown.messagePrefix ?? DEFAULTS.shutdown.messagePrefix,
      sigtermDelayMs: shutdown.sigtermDelayMs ?? DEFAULTS.shutdown.sigtermDelayMs,
      sigintDelayMs: shutdown.sigintDelayMs ?? DEFAULTS.shutdown.sigintDelayMs,
    },
  };

  validateCrossFieldConstraints(resolvedConfig);

  return resolvedConfig;
}
