/**
 * Circuit breaker — detects crash loops via a global sliding window.
 *
 * Tracked at the cluster level (not per worker.id): 5 different workers
 * crashing in succession count as 5 crashes. This matches the expected
 * behaviour — an app that fails to start should trip the breaker regardless
 * of which worker is involved.
 */
export class CrashTracker {
  private timestamps: number[] = [];
  private readonly maxSize: number;

  constructor(
    private readonly threshold: number,
    private readonly windowMs: number,
  ) {
    // Limit max size to prevent unbounded growth
    this.maxSize = Math.max(threshold * 2, 100);
  }

  /** Records a crash at the current timestamp. */
  record(): void {
    this.timestamps.push(Date.now());

    // Bounded growth: prune if over limit even if not checking trip
    if (this.timestamps.length > this.maxSize) {
      this.prune();
    }
  }

  /**
   * Returns true if the number of crashes within the sliding window
   * has reached or exceeded the configured threshold.
   */
  isTripped(): boolean {
    this.prune();
    return this.timestamps.length >= this.threshold;
  }

  /** Removes entries outside the sliding window. */
  prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);

    // Hard limit: keep only last maxSize entries
    if (this.timestamps.length > this.maxSize) {
      this.timestamps = this.timestamps.slice(-this.maxSize);
    }
  }

  /** Resets the counter (e.g. after a successful manual restart). */
  reset(): void {
    this.timestamps = [];
  }

  /** Number of crashes in the current window (after pruning). */
  get count(): number {
    this.prune();
    return this.timestamps.length;
  }
}
