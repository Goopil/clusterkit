import { describe, expect, it, vi } from "vitest";
import { SignalHandler } from "../src/signal-handler";

describe("SignalHandler", () => {
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
    signalHandler.register({ SIGUSR1: () => {} });

    expect(() => signalHandler.register({ SIGUSR2: () => {} })).toThrow("already registered");

    signalHandler.unregister();
  });
});
