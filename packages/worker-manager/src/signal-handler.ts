/**
 * Handles POSIX signal registration and cleanup.
 * Decouples signal handling from business logic.
 */
export class SignalHandler {
  private readonly handlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  private isRegistered = false;

  /**
   * Register signal handlers.
   * @param handlers Map of signal names to handler functions (only provided signals are registered)
   */
  register(handlers: Partial<Record<NodeJS.Signals, (() => void) | undefined>>): void {
    if (this.isRegistered) {
      throw new Error("SignalHandler already registered");
    }

    for (const [signal, handler] of Object.entries(handlers)) {
      if (!handler) continue;

      const wrappedHandler = (): void => handler();
      this.handlers.push({ signal: signal as NodeJS.Signals, handler: wrappedHandler });
      process.on(signal, wrappedHandler);
    }

    this.isRegistered = true;
  }

  /**
   * Remove all registered signal handlers.
   */
  unregister(): void {
    for (const { signal, handler } of this.handlers) {
      process.off(signal, handler);
    }
    this.handlers.length = 0;
    this.isRegistered = false;
  }

  /**
   * Check if handlers are registered.
   */
  isActive(): boolean {
    return this.isRegistered;
  }
}
