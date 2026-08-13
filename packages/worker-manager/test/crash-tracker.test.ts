import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CrashTracker } from "../src/crash-tracker";

describe("CrashTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("trips only when the threshold is reached inside the sliding window", () => {
    const tracker = new CrashTracker(2, 1_000);

    tracker.record();
    vi.advanceTimersByTime(999);
    tracker.record();

    expect(tracker.isTripped()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.count).toBe(1);
    expect(tracker.isTripped()).toBe(false);
  });

  it("clears recorded crashes when reset", () => {
    const tracker = new CrashTracker(2, 1_000);

    tracker.record();
    tracker.record();
    tracker.reset();

    expect(tracker.count).toBe(0);
    expect(tracker.isTripped()).toBe(false);
  });

  // ── Boundary conditions ─────────────────────────────────────────────────

  it("trips exactly at the threshold boundary", () => {
    const tracker = new CrashTracker(5, 1_000);

    for (let i = 0; i < 4; i++) tracker.record();
    expect(tracker.isTripped()).toBe(false); // 4 < 5

    tracker.record();
    expect(tracker.isTripped()).toBe(true); // 5 >= 5
  });

  it("does not trip with threshold-1 crashes", () => {
    const tracker = new CrashTracker(10, 5_000);

    for (let i = 0; i < 9; i++) tracker.record();

    expect(tracker.isTripped()).toBe(false);
    expect(tracker.count).toBe(9);
  });

  // ── Bounded growth ───────────────────────────────────────────────────────

  it("prunes to maxSize when exceeding the limit", () => {
    const tracker = new CrashTracker(2, 10_000);
    // maxSize = max(2 * 2, 100) = 100
    for (let i = 0; i < 150; i++) tracker.record();

    expect(tracker.count).toBe(100);
  });

  it("hard-limits to maxSize even within the window", () => {
    const tracker = new CrashTracker(50, 100_000);
    // maxSize = max(50 * 2, 100) = 100
    for (let i = 0; i < 200; i++) tracker.record();

    expect(tracker.count).toBe(100);
  });

  // ── Window expiry ────────────────────────────────────────────────────────

  it("expires all crashes after the window passes", () => {
    const tracker = new CrashTracker(3, 5_000);

    for (let i = 0; i < 5; i++) tracker.record();
    expect(tracker.isTripped()).toBe(true);

    vi.advanceTimersByTime(5_001);
    expect(tracker.count).toBe(0);
    expect(tracker.isTripped()).toBe(false);
  });

  it("keeps only recent crashes when window partially expires", () => {
    const tracker = new CrashTracker(3, 10_000);

    tracker.record(); // t=0
    vi.advanceTimersByTime(3_000);
    tracker.record(); // t=3000
    vi.advanceTimersByTime(3_000);
    tracker.record(); // t=6000
    vi.advanceTimersByTime(5_000); // t=11000 — first crash at t=0 is now outside window

    expect(tracker.count).toBe(2); // only t=3000 and t=6000 remain
  });

  // ── Concurrent record calls ──────────────────────────────────────────────

  it("handles synchronous burst of record() calls", () => {
    const tracker = new CrashTracker(100, 60_000);

    // Synchronous burst — all at the same timestamp
    for (let i = 0; i < 100; i++) tracker.record();

    expect(tracker.count).toBe(100);
    expect(tracker.isTripped()).toBe(true);
  });

  // ── Reset after tripping ─────────────────────────────────────────────────

  it("recovers after reset following a trip", () => {
    const tracker = new CrashTracker(3, 5_000);

    for (let i = 0; i < 3; i++) tracker.record();
    expect(tracker.isTripped()).toBe(true);

    tracker.reset();
    expect(tracker.isTripped()).toBe(false);
    expect(tracker.count).toBe(0);

    // Should trip again if crashes resume
    for (let i = 0; i < 3; i++) tracker.record();
    expect(tracker.isTripped()).toBe(true);
  });

  // ── Threshold of 1 ───────────────────────────────────────────────────────

  it("trips on a single crash when threshold is 1", () => {
    const tracker = new CrashTracker(1, 1_000);

    tracker.record();
    expect(tracker.isTripped()).toBe(true);
  });
});
