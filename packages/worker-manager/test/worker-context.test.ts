import type { ListenOptions } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerStartContext } from "../src/worker-context";

type TestListenable = { listen: (opts: ListenOptions) => unknown };

function makeTarget(returned?: unknown): { target: TestListenable; calls: ListenOptions[]; returned: unknown } {
  const calls: ListenOptions[] = [];
  const value = returned ?? { close: vi.fn() };
  return {
    target: {
      listen: (opts: ListenOptions) => {
        calls.push(opts);
        return value;
      },
    },
    calls,
    returned: value,
  };
}

/** Runs `fn` with `PORT` deleted from the environment, restoring it after. */
async function withoutPortEnv(fn: () => void): Promise<void> {
  const original = process.env.PORT;
  delete process.env.PORT;
  try {
    fn();
  } finally {
    if (original !== undefined) {
      process.env.PORT = original;
    } else {
      delete process.env.PORT;
    }
  }
  await Promise.resolve();
}

describe("createWorkerStartContext", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("listen", () => {
    it("sets exclusive/reusePort to true when the platform supports SO_REUSEPORT", () => {
      const { target, calls, returned } = makeTarget();
      const ctx = createWorkerStartContext({ reusePort: true, registerShutdown: vi.fn() });

      const result = ctx.listen(target, { port: 3000, host: "127.0.0.1" });

      expect(calls).toEqual([{ port: 3000, host: "127.0.0.1", exclusive: true, reusePort: true }]);
      expect(result).toBe(returned);
    });

    it("leaves both flags false so node:cluster IPC shares the port", () => {
      const { target, calls } = makeTarget();
      const ctx = createWorkerStartContext({ reusePort: false, registerShutdown: vi.fn() });

      ctx.listen(target, { port: 3000 });

      expect(calls[0]).toEqual({ port: 3000, host: "0.0.0.0", exclusive: false, reusePort: false });
    });

    it("defaults port to 3000 when PORT is unset", async () => {
      const { target, calls } = makeTarget();
      const ctx = createWorkerStartContext({ reusePort: false, registerShutdown: vi.fn() });

      await withoutPortEnv(() => ctx.listen(target));

      expect(calls[0]?.port).toBe(3000);
      expect(calls[0]?.host).toBe("0.0.0.0");
    });

    it("uses the PORT env var as default", () => {
      const { target, calls } = makeTarget();
      const ctx = createWorkerStartContext({ reusePort: false, registerShutdown: vi.fn() });

      vi.stubEnv("PORT", "4747");
      ctx.listen(target);

      expect(calls[0]?.port).toBe(4747);
    });

    it("falls back to 3000 when PORT is not numeric", () => {
      const { target, calls } = makeTarget();
      const ctx = createWorkerStartContext({ reusePort: false, registerShutdown: vi.fn() });

      vi.stubEnv("PORT", "not-a-port");
      ctx.listen(target);

      expect(calls[0]?.port).toBe(3000);
    });

    it("explicit options override the env defaults", () => {
      const { target, calls } = makeTarget();
      const ctx = createWorkerStartContext({ reusePort: false, registerShutdown: vi.fn() });

      vi.stubEnv("PORT", "4747");
      ctx.listen(target, { port: 8080, host: "127.0.0.1" });

      expect(calls[0]).toMatchObject({ port: 8080, host: "127.0.0.1" });
    });

    it("returns whatever target.listen() returns (the bound server)", () => {
      const server = { close: vi.fn(), on: vi.fn() };
      const { target } = makeTarget(server);
      const ctx = createWorkerStartContext({ reusePort: false, registerShutdown: vi.fn() });

      expect(ctx.listen(target, { port: 3000 })).toBe(server);
    });

    it("throws a TypeError when the target has no listen() method", () => {
      const ctx = createWorkerStartContext({ reusePort: false, registerShutdown: vi.fn() });

      expect(() => ctx.listen({} as TestListenable, { port: 3000 })).toThrow(TypeError);
      expect(() => ctx.listen(undefined as unknown as TestListenable)).toThrow(TypeError);
      expect(() => ctx.listen({ listen: "nope" } as unknown as TestListenable)).toThrow(
        "listen: target must expose a Node-style listen() method",
      );
    });
  });

  describe("shutdown", () => {
    it("delegates to registerOnShutdown", () => {
      const registered: Array<(signal: string) => void | Promise<void>> = [];
      const cb = (signal: string) => void signal;
      const ctx = createWorkerStartContext({
        reusePort: false,
        registerShutdown: (fn) => registered.push(fn),
      });

      ctx.shutdown(cb);

      expect(registered).toEqual([cb]);
    });

    it("supports async callbacks", async () => {
      let called = false;
      const registered: Array<(signal: string) => Promise<void>> = [];
      const ctx = createWorkerStartContext({
        reusePort: false,
        registerShutdown: (fn) => registered.push(fn),
      });

      ctx.shutdown(async () => {
        called = true;
      });
      await registered[0]?.("SIGTERM");

      expect(called).toBe(true);
    });
  });
});
