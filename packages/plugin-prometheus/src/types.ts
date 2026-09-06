import type { Server } from "node:http";
import type { OrchestratorPlugin } from "@goopil/clusterkit";
import type { Registry } from "prom-client";

export interface PrometheusPluginOptions {
  /** Metric name prefix. @default 'clusterkit_' */
  prefix?: string;
  /** Plug into an existing prom-client Registry for orchestration metrics. @default new Registry() */
  registry?: Registry;
  /** Collect Node.js default process metrics on workers only. @default true */
  defaultMetrics?: boolean;
  /**
   * Cache TTL (in ms) for merged metrics responses.
   * Every uncached call fans out an IPC round-trip to all workers, so a
   * non-zero TTL protects the cluster from concurrent/aggressive scrapes.
   * `0` disables caching.
   * @default 1000
   */
  metricsCacheTtlMs?: number;
  /**
   * Static labels added to every metric in the registry.
   * The process pid is always included automatically.
   * @example { env: 'production', region: 'eu-west-1', service: 'api' }
   */
  labels?: Record<string, string | number>;
}

export interface PrometheusPlugin extends OrchestratorPlugin {
  /**
   * Returns the current metrics as a Prometheus text string.
   * Merges orchestration metrics (primary) and per-worker default metrics (all workers).
   */
  getMetrics(): Promise<string>;
  /** The prom-client Registry used for orchestration metrics (primary only). */
  readonly registry: Registry;
  /**
   * Bind a primary-side HTTP server exposing `GET /metrics` and `GET /healthz`.
   * No-op in workers (returns undefined) — always bind on the primary, on its own
   * port: sharing the app's SO_REUSEPORT port would route scrape requests to
   * workers non-deterministically. The server is closed on uninstall (shutdown).
   */
  serve(options: { port: number; host?: string }): Promise<Server | undefined>;
}
