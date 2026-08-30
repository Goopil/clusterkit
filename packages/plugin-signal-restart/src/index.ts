import cluster from "node:cluster";
import {
  type Logger,
  type Orchestrator,
  type OrchestratorPlugin,
  type ResolvedConfig,
  withLoggerPrefix,
} from "@goopil/clusterkit";

export interface SignalRestartOptions {
  /** Signal to listen for. @default "SIGHUP" */
  signal?: NodeJS.Signals;
  /** Delay between draining worker N and starting worker N+1. @default 1000 */
  staggerMs?: number;
  /** Free-form reason string passed to restartWorkers. @default "signal:SIGHUP" */
  reason?: string;
}

export interface SignalRestartPlugin extends OrchestratorPlugin {
  /** Timestamp of the last successful restart, or undefined if none yet. */
  readonly lastRestart: Date | undefined;
}

export function createSignalRestartPlugin(options?: SignalRestartOptions): SignalRestartPlugin {
  const signal = options?.signal ?? "SIGHUP";
  const staggerMs = options?.staggerMs ?? 1_000;
  const defaultReason = options?.reason ?? `signal:${signal}`;

  let handler: (() => void) | undefined;
  let lastRestart: Date | undefined;

  return {
    name: "signal-restart",
    get lastRestart() {
      return lastRestart;
    },

    async install(orchestrator: Orchestrator, logger: Logger | null, config: ResolvedConfig): Promise<void> {
      if (!cluster.isPrimary) return;

      const log = withLoggerPrefix(logger, "clusterkit:signal-restart");

      const handleSignal = async () => {
        const reason = defaultReason;

        if (config.workers.count === 1) {
          log?.info("Signal received in single-worker mode, exiting for external restart", {
            signal,
            reason,
          });
          process.kill(process.pid, "SIGTERM");
          return;
        }

        log?.info("Signal received, initiating hot restart", { signal, reason });
        try {
          await orchestrator.restartWorkers({ staggerMs, reason });
          lastRestart = new Date();
        } catch (err) {
          log?.error("Hot restart failed", {
            reason,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      handler = () => {
        void handleSignal();
      };

      process.on(signal, handler);
      log?.debug("Signal restart plugin installed", { signal });
    },

    async uninstall(): Promise<void> {
      if (handler && cluster.isPrimary) {
        process.off(signal, handler);
        handler = undefined;
      }
    },
  };
}
