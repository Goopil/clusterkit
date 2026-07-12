// Main class

// CPU utilities (also useful standalone)
export { type CgroupLimits, getCgroupCpuLimit, readCgroupLimits } from "./cgroup";
// Logger utilities
export { createConsoleLogger, withLoggerPrefix } from "./logger";
export { Orchestrator } from "./orchestrator";
export type { PlatformCapabilities } from "./platform";
// Platform utilities (also useful standalone)
export { detectReusePortSupport, getPlatformCapabilities } from "./platform";
export { getCPUCount } from "./sizing";
// Public config & types (including plugin interface)
export type {
  HealthStatus,
  Logger,
  OrchestratorConfig,
  OrchestratorEvents,
  OrchestratorPlugin,
  ResolvedConfig,
  RestartConfig,
  ShutdownConfig,
  WorkerMetrics,
  WorkersConfig,
} from "./types";
export { isTypedMessage } from "./types";
// Validation error
export { WorkerManagerValidationError } from "./validation";
