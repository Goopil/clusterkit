import cluster from "node:cluster";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  type Logger,
  type Orchestrator,
  type OrchestratorPlugin,
  type ResolvedConfig,
  withLoggerPrefix,
} from "@goopil/clusterkit";
import chokidar, { type ChokidarOptions, type FSWatcher } from "chokidar";
import { parseEnvFile } from "./parse-env";

export { parseEnvFile } from "./parse-env";

export interface FileWatcherOptions {
  /** Literal paths (files or directories) to watch for changes — chokidar v4 has no glob support. */
  watch?: string[] | string;
  /** Options passed through to chokidar. */
  watchOptions?: ChokidarOptions;
  /** Patterns to ignore (passed to chokidar's `ignored`, which still supports globs). */
  ignore?: string[] | string;

  /** Path(s) to .env files to parse on change. */
  envFile?: string | string[];
  /** Custom .env parser (default: simple KEY=VALUE parser). */
  envParser?: (content: string) => Record<string, string>;

  /** Poll process.env for changes. @default false */
  pollEnv?: boolean;
  /** Interval for process.env polling. @default 5000 */
  pollEnvIntervalMs?: number;

  /** Debounce time for coalescing rapid changes. @default 300 */
  debounceMs?: number;
  /**
   * Max time to wait since the first unflushed change before firing the restart anyway,
   * even if changes keep resetting the debounce timer (a continuous storm would otherwise
   * starve the restart). 0 disables it. @default 0
   */
  debounceMaxWaitMs?: number;
  /**
   * Minimum delay between actual restarts: a debounced trigger firing within this window
   * after the last `restartWorkers` call is skipped. 0 disables it. @default 0
   */
  minRestartIntervalMs?: number;
  /** Delay between draining worker N and starting worker N+1. @default 1000 */
  staggerMs?: number;
  /** Reason string for restart events. @default "file-change" or "env-change" */
  reason?: string;

  /** Delay before starting watchers. @default 0 */
  startDelayMs?: number;

  /** Log what would restart without actually restarting. @default false */
  dryRun?: boolean;
}

export interface FileWatcherPlugin extends OrchestratorPlugin {
  readonly isWatching: boolean;
}

function toArray(value: string[] | string | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// chokidar v4/v5 match string `ignored` entries as literal paths (no globs),
// so the default node_modules filter must be a regex to take effect.
const NODE_MODULES_IGNORE = /(^|\/)node_modules(\/|$)/;

export function createFileWatcherPlugin(options?: FileWatcherOptions): FileWatcherPlugin {
  const watchPaths = toArray(options?.watch);
  const ignorePaths = toArray(options?.ignore);
  const envFiles = toArray(options?.envFile);
  const envParser = options?.envParser ?? parseEnvFile;
  const pollEnv = options?.pollEnv ?? false;
  const pollEnvIntervalMs = options?.pollEnvIntervalMs ?? 5_000;
  const debounceMs = options?.debounceMs ?? 300;
  const debounceMaxWaitMs = options?.debounceMaxWaitMs ?? 0;
  const minRestartIntervalMs = options?.minRestartIntervalMs ?? 0;
  const staggerMs = options?.staggerMs ?? 1_000;
  const startDelayMs = options?.startDelayMs ?? 0;
  const dryRun = options?.dryRun ?? false;
  const defaultReason = options?.reason;

  let watchers: FSWatcher[] = [];
  let envPollInterval: NodeJS.Timeout | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let maxWaitTimer: NodeJS.Timeout | undefined;
  let trailingTimer: NodeJS.Timeout | undefined;
  let startDelayTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let pendingReason: string | undefined;
  let pendingEnv: NodeJS.ProcessEnv | undefined;
  let lastRestartAt = 0;
  let watching = false;

  const teardown = async (): Promise<void> => {
    closed = true;
    if (startDelayTimer) {
      clearTimeout(startDelayTimer);
      startDelayTimer = undefined;
    }
    await Promise.all(watchers.map((w) => w.close()));
    watchers = [];
    if (envPollInterval) {
      clearInterval(envPollInterval);
      envPollInterval = undefined;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = undefined;
    }
    if (trailingTimer) {
      clearTimeout(trailingTimer);
      trailingTimer = undefined;
    }
    watching = false;
  };

  return {
    name: "file-watcher",
    get isWatching() {
      return watching;
    },

    async install(orchestrator: Orchestrator, logger: Logger | null, _config: ResolvedConfig): Promise<void> {
      // Reinstalling the same instance after uninstall/shutdown must start
      // watchers again, not stay latched at `closed = true`.
      closed = false;
      lastRestartAt = 0;

      if (!cluster.isPrimary) return;

      const log = withLoggerPrefix(logger, "clusterkit:file-watcher");

      if (orchestrator.workerCount === 1) {
        log?.warn("file-watcher plugin has no effect in single-worker mode");
        return;
      }

      const flushRestart = async (): Promise<void> => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = undefined;
        }
        if (maxWaitTimer) {
          clearTimeout(maxWaitTimer);
          maxWaitTimer = undefined;
        }
        if (trailingTimer) {
          clearTimeout(trailingTimer);
          trailingTimer = undefined;
        }
        const reason = pendingReason ?? "file-change";
        const env = pendingEnv;
        if (dryRun) {
          pendingReason = undefined;
          pendingEnv = undefined;
          log?.info("Dry run — would trigger hot restart", { reason });
          return;
        }
        if (minRestartIntervalMs > 0 && Date.now() - lastRestartAt < minRestartIntervalMs) {
          log?.debug("Skipping hot restart, within min restart interval", { reason, minRestartIntervalMs });
          // Trailing flush: retry after the remaining interval, keeping the pending payload.
          if (!trailingTimer) {
            const remaining = minRestartIntervalMs - (Date.now() - lastRestartAt);
            trailingTimer = setTimeout(() => void flushRestart(), remaining).unref();
          }
          return;
        }
        pendingReason = undefined;
        pendingEnv = undefined;
        log?.info("Triggering hot restart", { reason });
        lastRestartAt = Date.now();
        try {
          await orchestrator.restartWorkers({ env, staggerMs, reason });
        } catch (err) {
          log?.error("Hot restart failed", {
            reason,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      const triggerRestart = (reason: string, env?: NodeJS.ProcessEnv): void => {
        pendingReason = reason;
        // Merge instead of overwrite so a plain file change doesn't erase a pending .env payload.
        pendingEnv = env === undefined ? pendingEnv : { ...pendingEnv, ...env };
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => void flushRestart(), debounceMs).unref();
        // Anti-starvation: arm the max-wait timer once, on the first unflushed change,
        // so a continuous storm still fires a restart after debounceMaxWaitMs.
        if (debounceMaxWaitMs > 0 && !maxWaitTimer) {
          maxWaitTimer = setTimeout(() => void flushRestart(), debounceMaxWaitMs).unref();
        }
      };

      const startWatchers = (): void => {
        if (closed) return;
        // File watchers — chokidar for cross-platform reliability (v4: literal paths only)
        if (watchPaths.length > 0) {
          const chokidarOpts: ChokidarOptions = {
            ignoreInitial: true,
            ...options?.watchOptions,
            // Ignore node_modules by default: watching it turns a `pnpm install`
            // into a fleet-wide restart storm. An explicit `watchOptions.ignored`
            // wins entirely; `ignore` patterns are merged after the default.
            ignored: options?.watchOptions?.ignored ?? [NODE_MODULES_IGNORE, ...ignorePaths],
          };
          try {
            const w = chokidar.watch(watchPaths, chokidarOpts);
            const envAbsPaths = new Set(envFiles.map((f) => resolvePath(f)));
            w.on("change", (filePath) => {
              if (envAbsPaths.has(resolvePath(filePath))) return; // handled by env watcher
              log?.debug("File changed", { file: filePath });
              triggerRestart(defaultReason ?? "file-change");
            });
            w.on("add", (filePath) => {
              if (envAbsPaths.has(resolvePath(filePath))) return;
              log?.debug("File added", { file: filePath });
              triggerRestart(defaultReason ?? "file-change");
            });
            w.on("unlink", (filePath) => {
              if (envAbsPaths.has(resolvePath(filePath))) return;
              log?.debug("File removed", { file: filePath });
              triggerRestart(defaultReason ?? "file-change");
            });
            watchers.push(w);
          } catch (err) {
            log?.error("Failed to start file watcher", {
              paths: watchPaths,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // .env file watchers — separate chokidar instance for .env files
        if (envFiles.length > 0) {
          try {
            const w = chokidar.watch(envFiles, {
              ignoreInitial: true,
              ...options?.watchOptions,
            });
            w.on("change", (filePath) => {
              log?.debug(".env file changed", { file: filePath });
              try {
                const content = readFileSync(resolvePath(filePath), "utf-8");
                const parsed = envParser(content);
                triggerRestart(defaultReason ?? "env-change", parsed);
              } catch (err) {
                log?.error("Failed to read/parse .env file", {
                  file: filePath,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            });
            watchers.push(w);
          } catch (err) {
            log?.error("Failed to start .env file watcher", {
              files: envFiles,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // process.env polling
        if (pollEnv) {
          let snapshot = new Map(Object.entries(process.env));
          envPollInterval = setInterval(() => {
            const current = new Map(Object.entries(process.env));
            let changed = false;
            for (const [key, value] of current) {
              if (snapshot.get(key) !== value) {
                changed = true;
                break;
              }
            }
            if (!changed) {
              for (const [key] of snapshot) {
                if (!current.has(key)) {
                  changed = true;
                  break;
                }
              }
            }
            if (changed) {
              log?.debug("process.env changed, triggering restart");
              snapshot = current;
              triggerRestart(defaultReason ?? "env-change", { ...process.env });
            }
          }, pollEnvIntervalMs).unref();
        }

        watching = true;
        log?.debug("File watcher started", {
          watchPaths,
          envFiles,
          pollEnv,
          dryRun,
        });
      };

      const start = (): void => {
        if (startDelayMs > 0) {
          startDelayTimer = setTimeout(startWatchers, startDelayMs).unref();
        } else {
          startWatchers();
        }
      };

      start();

      orchestrator.registerOnShutdown(async () => {
        await teardown();
      });
    },

    async uninstall(): Promise<void> {
      await teardown();
    },
  };
}
