import type { Worker } from "node:cluster";
import type { Logger, ResolvedConfig, WorkerMetrics } from "./types";
import { isTypedMessage } from "./types";

/**
 * Coordinates graceful shutdown of workers and cleanup.
 * Handles the full shutdown sequence: notify, wait, kill, cleanup.
 */
export class ShutdownCoordinator {
  private readonly cfg: ResolvedConfig;
  private readonly log: Logger | null;
  private readonly metrics: WorkerMetrics;

  // State
  private isShuttingDown = false;

  // IPC message types
  private readonly shutdownType: string;
  private readonly shutdownAckType: string;

  // Callbacks (injected from Orchestrator)
  private onShutdownStart?: (signal: string) => void;
  private onShutdownComplete?: (metrics: WorkerMetrics) => void;

  constructor(cfg: ResolvedConfig, log: Logger | null, metrics: WorkerMetrics, messagePrefix: string) {
    this.cfg = cfg;
    this.log = log;
    this.metrics = metrics;
    this.shutdownType = `${messagePrefix}:shutdown`;
    this.shutdownAckType = `${messagePrefix}:shutdown-ack`;
  }

  /**
   * Set up event callbacks.
   */
  setupCallbacks(onStart: (signal: string) => void, onComplete: (metrics: WorkerMetrics) => void): void {
    this.onShutdownStart = onStart;
    this.onShutdownComplete = onComplete;
  }

  /**
   * Check if shutdown is in progress.
   */
  isShutdownInProgress(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Initiate coordinated shutdown of workers.
   */
  async initiateShutdown(workers: Worker[], signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.log?.info("Shutdown coordinator initiated", { signal });
    this.onShutdownStart?.(signal);

    // Attach error listeners to all workers for the duration of shutdown.
    // When a worker exits while we are calling send() or disconnect(),
    // Node emits an async 'error' event on the Worker instance (not on
    // worker.process). Without a listener this becomes an uncaught
    // exception. These errors are expected during shutdown.
    const errorHandlers = new Map<Worker, (err: Error) => void>();
    for (const worker of workers) {
      const handler = (err: Error): void => {
        this.log?.debug("Worker error during shutdown", {
          workerId: worker.id,
          error: err,
        });
      };
      errorHandlers.set(worker, handler);
      worker.on("error", handler);
    }

    try {
      // 1. Send shutdown message and wait for ACKs
      await this.sendShutdownAndWaitAcks(workers);

      // 2. Wait for workers to exit
      await this.waitForWorkersToExit(workers);

      // 3. Force-kill any survivors
      const survivors = workers.filter((w) => !w.isDead());
      if (survivors.length > 0) {
        this.log?.warn("Force killing survivors", { count: survivors.length });
        await Promise.all(survivors.map((w) => this.killWorkerGradually(w)));
      }
    } finally {
      for (const [worker, handler] of errorHandlers) {
        worker.off("error", handler);
      }
    }

    this.log?.info("All workers terminated");
    this.onShutdownComplete?.({ ...this.metrics });
  }

  /**
   * Send shutdown message to workers and wait for ACKs.
   */
  private async sendShutdownAndWaitAcks(workers: Worker[]): Promise<void> {
    const results = await Promise.all(workers.map((worker) => this.waitForWorkerAck(worker)));
    const notAcked = results.filter((acked) => !acked).length;

    if (notAcked > 0) {
      this.log?.warn("Some workers did not ACK shutdown", { count: notAcked });
    }
  }

  /**
   * Wait for a single worker to ACK shutdown.
   * Resolves `true` when the worker ACKed or was already gone; `false` when
   * the ACK never arrived (timeout, error, early exit, or failed send).
   */
  private waitForWorkerAck(worker: Worker): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (worker.isDead() || !worker.isConnected()) {
        resolve(true);
        return;
      }

      let ackTimeoutId: NodeJS.Timeout | undefined;

      const disconnectWorker = (): void => {
        if (!worker.isDead() && worker.isConnected()) {
          try {
            worker.disconnect();
          } catch (err) {
            this.log?.debug("Worker disconnect failed (likely already exited)", {
              workerId: worker.id,
              error: err,
            });
          }
        }
      };

      const cleanup = (): void => {
        worker.off("message", ackHandler);
        worker.off("exit", terminalHandler);
        worker.off("disconnect", terminalHandler);
        worker.off("error", errorHandler);
        if (ackTimeoutId) {
          clearTimeout(ackTimeoutId);
          ackTimeoutId = undefined;
        }
      };

      const errorHandler = (err: Error): void => {
        this.log?.debug("Worker error during ACK wait", {
          workerId: worker.id,
          error: err,
        });
        cleanup();
        resolve(false);
      };

      const sendShutdown = (): void => {
        try {
          worker.send({ type: this.shutdownType });
        } catch (err) {
          this.log?.debug("Failed to send shutdown to worker", {
            workerId: worker.id,
            error: err,
          });
          cleanup();
          disconnectWorker();
          resolve(false);
        }
      };

      const ackHandler = (msg: unknown): void => {
        if (this.isShutdownAck(msg)) {
          cleanup();
          disconnectWorker();
          this.log?.info("Worker ACK received", { workerId: worker.id });
          resolve(true);
        }
      };

      const terminalHandler = (): void => {
        cleanup();
        this.log?.info("Worker terminated before shutdown ACK", { workerId: worker.id });
        resolve(false);
      };

      worker.on("message", ackHandler);
      worker.once("exit", terminalHandler);
      worker.once("disconnect", terminalHandler);
      worker.on("error", errorHandler);

      // Individual timeout per worker
      ackTimeoutId = setTimeout(() => {
        cleanup();
        disconnectWorker();
        this.log?.warn("Worker ACK timeout", { workerId: worker.id });
        resolve(false);
      }, this.cfg.shutdown.ackTimeoutMs);

      // Send shutdown message
      sendShutdown();
    });
  }

  /**
   * Wait for all workers to exit (with timeout).
   */
  private waitForWorkersToExit(workers: Worker[]): Promise<void> {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, this.cfg.shutdown.timeoutMs);

      const checkAllDead = (): void => {
        if (workers.every((w) => w.isDead())) {
          clearTimeout(timeout);
          resolve();
        }
      };

      checkAllDead();

      for (const worker of workers) {
        if (!worker.isDead()) worker.once("exit", checkAllDead);
      }
    });
  }

  /**
   * Kill a worker gradually: SIGTERM → SIGINT → SIGKILL.
   */
  private async killWorkerGradually(worker: Worker): Promise<void> {
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    if (!worker.isDead()) {
      worker.process.kill("SIGTERM");
      await delay(this.cfg.shutdown.sigtermDelayMs);
    }

    if (!worker.isDead()) {
      this.log?.warn("Escalating to SIGINT", { workerId: worker.id });
      worker.process.kill("SIGINT");
      await delay(this.cfg.shutdown.sigintDelayMs);
    }

    if (!worker.isDead()) {
      this.log?.error("Forced SIGKILL", { workerId: worker.id });
      worker.process.kill("SIGKILL");
      this.metrics.forcedKills++;
    }
  }

  /**
   * Type guard for shutdown ACK messages.
   */
  private isShutdownAck(msg: unknown): msg is { type: string } {
    return isTypedMessage(msg, this.shutdownAckType);
  }
}
