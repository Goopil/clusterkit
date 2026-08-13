import { EventEmitter } from "node:events";
import { vi } from "vitest";

import { MockWorker } from "./mock-worker";

/**
 * Shared mock cluster for unit tests. Extends EventEmitter to simulate node:cluster.
 */
export class MockCluster extends EventEmitter {
  workers: Record<number, MockWorker> = {};
  readonly setupPrimary = vi.fn();
  readonly fork = vi.fn((env?: NodeJS.ProcessEnv) => {
    const worker = new MockWorker(this.nextId++);
    this.workers[worker.id] = worker;
    this._lastEnv = env;
    return worker;
  });

  private nextId = 1;
  private _lastEnv: NodeJS.ProcessEnv | undefined;

  get lastEnv(): NodeJS.ProcessEnv | undefined {
    return this._lastEnv;
  }

  /** Remove a worker from the workers map and emit the exit event. */
  simulateExit(worker: MockWorker, code: number | null = 0, signal: string | null = null): void {
    if (!worker.dead) {
      worker.exit(code ?? 0);
    }
    delete this.workers[worker.id];
    this.emit("exit", worker, code, signal);
  }

  /** Emit the online event for a worker. */
  simulateOnline(worker: MockWorker): void {
    this.emit("online", worker);
  }
}
