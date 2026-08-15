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
  /** Globs/paths to watch for file changes. */
  watch?: string[] | string;
  /** Options passed through to chokidar. */
  watchOptions?: ChokidarOptions;
  /** Globs to ignore. */
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

export function createFileWatcherPlugin(options?: FileWatcherOptions): FileWatcherPlugin {
  const watchPaths = options?.watch ? (Array.isArray(options.watch) ? options.watch : [options.watch]) : [];
  const ignorePaths = options?.ignore ? (Array.isArray(options.ignore) ? options.ignore : [options.ignore]) : [];
  const envFiles = options?.envFile ? (Array.isArray(options.envFile) ? options.envFile : [options.envFile]) : [];
  const envParser = options?.envParser ?? parseEnvFile;
  const pollEnv = options?.pollEnv ?? false;
  const pollEnvIntervalMs = options?.pollEnvIntervalMs ?? 5_000;
  const debounceMs = options?.debounceMs ?? 300;
  const staggerMs = options?.staggerMs ?? 1_000;
  const startDelayMs = options?.startDelayMs ?? 0;
  const dryRun = options?.dryRun ?? false;
  const defaultReason = options?.reason;

  let watchers: FSWatcher[] = [];
  let envPollInterval: NodeJS.Timeout | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let envSnapshot: Map<string, string> | undefined;
  let watching = false;

  return {
    name: "file-watcher",
    get isWatching() {
      return watching;
    },

    async install(orchestrator: Orchestrator, logger: Logger | null, config: ResolvedConfig): Promise<void> {
      if (!cluster.isPrimary) return;

      const log = withLoggerPrefix(logger, "clusterkit:file-watcher");

      if (config.workers.count === 1) {
        log?.warn("file-watcher plugin has no effect in single-worker mode");
        return;
      }

      const triggerRestart = (reason: string, env?: NodeJS.ProcessEnv): void => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          debounceTimer = undefined;
          if (dryRun) {
            log?.info("Dry run — would trigger hot restart", { reason });
            return;
          }
          log?.info("Triggering hot restart", { reason });
          try {
            await orchestrator.restartWorkers({ env, staggerMs, reason });
          } catch (err) {
            log?.error("Hot restart failed", {
              reason,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, debounceMs).unref();
      };

      const startWatchers = (): void => {
        // File watchers — chokidar for glob support and cross-platform reliability
        if (watchPaths.length > 0) {
          const chokidarOpts: ChokidarOptions = {
            ignoreInitial: true,
            ignored: ignorePaths.length > 0 ? ignorePaths : undefined,
            ...options?.watchOptions,
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
          envSnapshot = new Map(Object.entries(process.env));
          envPollInterval = setInterval(() => {
            const current = new Map(Object.entries(process.env));
            let changed = false;
            for (const [key, value] of current) {
              if (envSnapshot!.get(key) !== value) {
                changed = true;
                break;
              }
            }
            if (!changed) {
              for (const [key] of envSnapshot!) {
                if (!current.has(key)) {
                  changed = true;
                  break;
                }
              }
            }
            if (changed) {
              log?.debug("process.env changed, triggering restart");
              envSnapshot = current;
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
          setTimeout(startWatchers, startDelayMs).unref();
        } else {
          startWatchers();
        }
      };

      start();

      orchestrator.registerOnShutdown(async () => {
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
        watching = false;
      });
    },

    async uninstall(): Promise<void> {
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
      watching = false;
    },
  };
}
