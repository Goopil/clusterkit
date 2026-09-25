import type { ListenOptions } from "node:net";

/**
 * Anything with a Node-style `listen()` — an express app, a raw `http.Server`,
 * a Koa or Fastify server. Kept permissive on purpose: framework `listen`
 * signatures vary, but they all accept a single options object at runtime.
 */
export type Listenable = {
  listen(...args: unknown[]): unknown;
};

/** Options accepted by the worker context `listen()` helper. */
export interface ListenParams {
  /** Defaults to the `PORT` env var (fallback 3000). */
  port?: number | string;
  /** Defaults to `0.0.0.0`. */
  host?: string;
}

/**
 * Helpers handed to the `run(start)` callback in every worker process.
 * The callback is never called in the primary, so these are worker-only.
 */
export interface WorkerStartContext {
  /**
   * Bind a server with the right flags for the current platform:
   * `SO_REUSEPORT` + `exclusive` when the kernel balances connections across
   * workers, cluster IPC round-robin otherwise. Replaces the manual
   * `getCapabilities()` + `exclusive`/`reusePort` dance.
   *
   * Defaults: `PORT` env var (fallback 3000), host `0.0.0.0`.
   * Returns whatever `target.listen()` returns (the bound server) so callers
   * can register their own close via `shutdown(() => server.close())`.
   */
  listen<T extends Listenable>(target: T, opts?: ListenParams): ReturnType<T["listen"]>;
  /**
   * Register a shutdown callback for this worker — same as
   * `orchestrator.registerOnShutdown(cb)`.
   */
  shutdown(cb: (signal: string) => void | Promise<void>): void;
}

export function createWorkerStartContext(options: {
  reusePort: boolean;
  registerShutdown: (cb: (signal: string) => void | Promise<void>) => void;
}): WorkerStartContext {
  const { reusePort, registerShutdown } = options;

  const buildListenOptions = (opts?: ListenParams): ListenOptions => ({
    port: opts?.port ?? (Number(process.env.PORT) || 3000),
    host: opts?.host ?? "0.0.0.0",
    // With SO_REUSEPORT each worker binds directly and the kernel distributes
    // connections; without it the node:cluster IPC path shares one primary-side
    // handle — passing exclusive: false is what enables that fallback.
    exclusive: reusePort,
    reusePort,
  });

  return {
    listen: <T extends Listenable>(target: T, opts?: ListenParams): ReturnType<T["listen"]> => {
      if (typeof target?.listen !== "function") {
        throw new TypeError("listen: target must expose a Node-style listen() method");
      }
      return target.listen(buildListenOptions(opts)) as ReturnType<T["listen"]>;
    },
    shutdown: registerShutdown,
  };
}
