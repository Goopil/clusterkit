import { describe, expect, it } from "vitest";
import { isTypedMessage } from "../src/types";

describe("isTypedMessage", () => {
  it("returns true when msg has the expected type", () => {
    expect(isTypedMessage({ type: "app:shutdown" }, "app:shutdown")).toBe(true);
  });

  it("returns false when msg type does not match", () => {
    expect(isTypedMessage({ type: "app:shutdown" }, "app:shutdown-ack")).toBe(false);
  });

  it("returns false when msg is null", () => {
    expect(isTypedMessage(null, "app:shutdown")).toBe(false);
  });

  it("returns false when msg is undefined", () => {
    expect(isTypedMessage(undefined, "app:shutdown")).toBe(false);
  });

  it("returns false when msg is an array", () => {
    expect(isTypedMessage([1, 2, 3], "app:shutdown")).toBe(false);
  });

  it("returns false when msg is a string", () => {
    expect(isTypedMessage("hello", "app:shutdown")).toBe(false);
  });

  it("returns false when msg is a number", () => {
    expect(isTypedMessage(42, "app:shutdown")).toBe(false);
  });

  it("returns false when msg has no type field", () => {
    expect(isTypedMessage({ foo: "bar" }, "app:shutdown")).toBe(false);
  });

  it("returns false when msg type is a number not a string", () => {
    expect(isTypedMessage({ type: 123 }, "app:shutdown")).toBe(false);
  });

  it("narrows the type correctly (type guard)", () => {
    const msg: unknown = { type: "app:shutdown", extra: "data" };
    if (isTypedMessage(msg, "app:shutdown")) {
      // TypeScript narrows to { type: string }
      expect(msg.type).toBe("app:shutdown");
    } else {
      expect.fail("should have been a typed message");
    }
  });

  it("preserves extra properties on the object", () => {
    const msg = { type: "app:shutdown", workerId: 5, pid: 1234 };
    expect(isTypedMessage(msg, "app:shutdown")).toBe(true);
  });
});
