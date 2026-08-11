import { EventEmitter } from "node:events";
import { vi } from "vitest";

export interface MockWorkerOptions {
  /** When true, auto-ACKs shutdown messages by emitting a matching ack message. @default false */
  autoAck?: boolean;
  /** When true, sets dead=true and emits exit+disconnect on disconnect(). @default true */
  deadOnDisconnect?: boolean;
  /** IPC message prefix for auto-ack. @default "__wm" */
  messagePrefix?: string;
  /** Starting PID. @default 1000 */
  pid?: number;
}

/**
 * Shared mock worker for unit tests. Extends EventEmitter to simulate node:cluster Worker.
 * Configure behavior via options instead of reimplementing per test file.
 */
export class MockWorker extends EventEmitter {
  readonly id: number;
  readonly process: { pid: number; kill: ReturnType<typeof vi.fn> };
  readonly send = vi.fn((message: { type: string }) => {
    if (this.autoAck) {
      queueMicrotask(() => this.emit("message", { type: message.type.replace(":shutdown", ":shutdown-ack") }));
    }
    return true;
  });
  readonly isDead = vi.fn(() => this.dead);
  readonly isConnected = vi.fn(() => this.connected);
  readonly disconnect = vi.fn(() => {
    this.connected = false;
    if (this.deadOnDisconnect) {
      this.dead = true;
      this.emit("disconnect");
      this.emit("exit", 0, null);
    }
  });
  readonly exit = vi.fn((code = 0) => {
    this.dead = true;
    this.emit("exit", code, null);
  });

  dead = false;
  connected = true;
  private autoAck: boolean;
  private deadOnDisconnect: boolean;

  constructor(id: number, options: MockWorkerOptions = {}) {
    super();
    this.id = id;
    this.autoAck = options.autoAck ?? false;
    this.deadOnDisconnect = options.deadOnDisconnect ?? true;
    this.process = {
      pid: options.pid ?? 1000 + id,
      kill: vi.fn((signal?: string) => {
        if (signal === "SIGKILL") {
          this.dead = true;
          this.emit("exit", 1, signal);
          this.emit("disconnect");
        }
        return true;
      }),
    };
  }
}
