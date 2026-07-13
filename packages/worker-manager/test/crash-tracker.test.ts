import { describe, expect, it, vi } from "vitest";
import { CrashTracker } from "../src/crash-tracker";

describe("CrashTracker", () => {
  it("trips only when the threshold is reached inside the sliding window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const tracker = new CrashTracker(2, 1_000);

    tracker.record();
    vi.advanceTimersByTime(999);
    tracker.record();

    expect(tracker.isTripped()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.count).toBe(1);
    expect(tracker.isTripped()).toBe(false);

    vi.useRealTimers();
  });

  it("clears recorded crashes when reset", () => {
    const tracker = new CrashTracker(2, 1_000);

    tracker.record();
    tracker.record();
    tracker.reset();

    expect(tracker.count).toBe(0);
    expect(tracker.isTripped()).toBe(false);
  });
});
