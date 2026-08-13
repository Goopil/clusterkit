import type cluster from "node:cluster";

import type { Orchestrator } from "./orchestrator";

// ============================================================================
// Logger
// ============================================================================

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ============================================================================
// Health & Metrics
// ============================================================================

export interface HealthStatus {
  ready: boolean;
  live: boolean;
}

export interface WorkerMetrics {
  workerRestarts: number;
  activeWorkers: number;
  crashLoopBackoffs: number;
  gracefulShutdowns: number;
  forcedKills: number;
}

// ============================================================================
// Config
// ============================================================================

export interface WorkersConfig {
  /** Number of workers to spawn, or 'auto' to detect via CPU count / SO_REUSEPORT. @default 'auto' */
  count?: number | "auto";
  /** Environment variables injected into each worker (merged on top of process.env). */
  env?: NodeJS.ProcessEnv;
  /** Node.js arguments passed to workers (e.g. ['--max-old-space-size=512']). */
  execArgv?: string[];
  /** Maximum worker age before recycling in ms. 0 = disabled. @default 0 */
  maxAgeMs?: number;
}

export interface RestartConfig {
  /** Number of crashes within the window before stopping restarts. @default 5 */
  crashThreshold?: number;
  /** Sliding window duration for the circuit breaker in ms. @default 60000 */
  crashWindowMs?: number;
  /** Initial delay before first restart in ms. @default 1000 */
  backoffMs?: number;
  /** Maximum delay between restarts in ms. @default 30_000 */
  maxBackoffMs?: number;
  /** Multiplier for exponential backoff. @default 2 */
  backoffMultiplier?: number;
  /** Time in ms the cluster must remain crash-free before backoff resets. 0 = immediate reset. @default 30_000 */
  stabilityWindowMs?: number;
}

export interface ShutdownConfig {
  /** Graceful shutdown timeout in ms before force kill. @default 12000 */
  timeoutMs?: number;
  /** Timeout for waiting worker ACKs during shutdown in ms. @default 3000 */
  ackTimeoutMs?: number;
  /** Prefix for internal IPC messages. Change if it collides with your app. @default '__wm' */
  messagePrefix?: string;
  /** Delay before escalating SIGTERM → SIGINT in ms. @default 2000 */
  sigtermDelayMs?: number;
  /** Delay before escalating SIGINT → SIGKILL in ms. @default 1000 */
  sigintDelayMs?: number;
}

export interface OrchestratorConfig {
  /** pino/winston/console-compatible logger. null = silent. @default null */
  logger?: Logger | null;
  /** Worker count and worker process options. */
  workers?: WorkersConfig;
  /** Crash handling and restart policy options. */
  restart?: RestartConfig;
  /** Shutdown lifecycle and signaling options. */
  shutdown?: ShutdownConfig;
  /** Custom cluster module (for testing only). @internal */
  clusterModule?: typeof cluster;
}

/**
 * Config with all defaults applied — internal use only.
 * `workers.env`, `workers.execArgv` and `clusterModule` remain optionally undefined
 * because they have no meaningful default value.
 */
export type ResolvedConfig = {
  logger: Logger | null;
  workers: {
    count: number | "auto";
    env: NodeJS.ProcessEnv | undefined;
    execArgv: string[] | undefined;
    maxAgeMs: number;
  };
  restart: {
    crashThreshold: number;
    crashWindowMs: number;
    backoffMs: number;
    maxBackoffMs: number;
    backoffMultiplier: number;
    stabilityWindowMs: number;
  };
  shutdown: {
    timeoutMs: number;
    ackTimeoutMs: number;
    messagePrefix: string;
    sigtermDelayMs: number;
    sigintDelayMs: number;
  };
  clusterModule: typeof cluster | undefined;
};

// ============================================================================
// Plugin interface
// ============================================================================

export interface OrchestratorPlugin {
  readonly name: string;
  install(orchestrator: Orchestrator, logger: Logger | null, config: ResolvedConfig): void | Promise<void>;
  uninstall?(orchestrator: Orchestrator): void | Promise<void>;
}

// ============================================================================
// EventEmitter — typed events
// ============================================================================

export interface OrchestratorEvents {
  "worker:online": [data: { workerId: number; pid: number }];
  "worker:exit": [
    data: { workerId: number; pid: number; code: number | null; signal: string | null; graceful: boolean },
  ];
  "worker:crash": [data: { workerId: number; pid: number; code: number | null; signal: string | null }];
  "worker:restart": [data: { newWorkerId: number; newPid: number }];
  "worker:recycle": [data: { workerId: number; pid: number; ageMs: number }];
  "shutdown:start": [data: { signal: string }];
  "shutdown:complete": [data: { metrics: WorkerMetrics }];
  "circuit-breaker:tripped": [data: { crashCount: number; windowMs: number }];
}

/** Type guard for IPC messages with required 'type' field */
export function isTypedMessage(msg: unknown, expectedType: string): msg is { type: string } {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return false;
  }

  const record = msg as Record<string, unknown>;
  return record.type === expectedType;
}
