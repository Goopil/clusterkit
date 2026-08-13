import { afterEach, describe, expect, it, vi } from "vitest";

import { SignalHandler } from "../src/signal-handler";

describe("SignalHandler", () => {
  afterEach(() => {
    // Clean up any leftover handlers
    process.removeAllListeners("SIGUSR1");
    process.removeAllListeners("SIGUSR2");
    process.removeAllListeners("SIGHUP");
  });

  it("forwards registered signals and removes them on unregister", () => {
    const handler = vi.fn();
    const signalHandler = new SignalHandler();

    signalHandler.register({ SIGUSR1: handler });
    process.emit("SIGUSR1");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(signalHandler.isActive()).toBe(true);

    signalHandler.unregister();
    process.emit("SIGUSR1");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(signalHandler.isActive()).toBe(false);
  });

  it("rejects duplicate registration", () => {
    const signalHandler = new SignalHandler();
    signalHandler.register({
      SIGUSR1: () => {},
    });

    expect(() =>
      signalHandler.register({
        SIGUSR2: () => {},
      }),
    ).toThrow("already registered");

    signalHandler.unregister();
  });

  // ── Multi-signal ─────────────────────────────────────────────────────────

  it("registers multiple signals at once", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();
    const signalHandler = new SignalHandler();

    signalHandler.register({ SIGUSR1: h1, SIGUSR2: h2, SIGHUP: h3 });

    process.emit("SIGUSR1");
    process.emit("SIGUSR2");
    process.emit("SIGHUP");

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h3).toHaveBeenCalledTimes(1);

    signalHandler.unregister();

    process.emit("SIGUSR1");
    process.emit("SIGUSR2");
    process.emit("SIGHUP");

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h3).toHaveBeenCalledTimes(1);
  });

  // ── Undefined handlers skipped ───────────────────────────────────────────

  it("skips undefined handlers without registering them", () => {
    const signalHandler = new SignalHandler();
    const h1 = vi.fn();

    signalHandler.register({ SIGUSR1: h1, SIGUSR2: undefined });

    expect(process.listenerCount("SIGUSR1")).toBe(1);
    expect(process.listenerCount("SIGUSR2")).toBe(0);

    signalHandler.unregister();
  });

  // ── Re-register after unregister ─────────────────────────────────────────

  it("allows re-registration after unregister", () => {
    const signalHandler = new SignalHandler();
    const h1 = vi.fn();

    signalHandler.register({ SIGUSR1: h1 });
    signalHandler.unregister();

    const h2 = vi.fn();
    signalHandler.register({ SIGUSR1: h2 });
    process.emit("SIGUSR1");

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);

    signalHandler.unregister();
  });

  // ── Empty registration ─────────────────────────────────────────────────────

  it("accepts empty registration and marks as active", () => {
    const signalHandler = new SignalHandler();

    signalHandler.register({});

    expect(signalHandler.isActive()).toBe(true);

    signalHandler.unregister();
    expect(signalHandler.isActive()).toBe(false);
  });
});
