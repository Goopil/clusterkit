import { describe, expect, it } from "vitest";
import { parseEnvFile } from "../src/parse-env";

describe("parseEnvFile", () => {
  it("parses simple KEY=VALUE pairs", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips empty lines", () => {
    const result = parseEnvFile("FOO=bar\n\nBAZ=qux\n\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips comments starting with #", () => {
    const result = parseEnvFile("# comment\nFOO=bar\n# another\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips surrounding double quotes", () => {
    const result = parseEnvFile('FOO="bar baz"');
    expect(result).toEqual({ FOO: "bar baz" });
  });

  it("strips surrounding single quotes", () => {
    const result = parseEnvFile("FOO='bar baz'");
    expect(result).toEqual({ FOO: "bar baz" });
  });

  it("skips lines without =", () => {
    const result = parseEnvFile("FOO=bar\nINVALID\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles empty file", () => {
    expect(parseEnvFile("")).toEqual({});
  });

  it("handles value containing =", () => {
    const result = parseEnvFile("URL=postgres://user:pass@host:5432/db");
    expect(result).toEqual({ URL: "postgres://user:pass@host:5432/db" });
  });

  it("trims whitespace around key and value", () => {
    const result = parseEnvFile("  FOO  =  bar  ");
    expect(result).toEqual({ FOO: "bar" });
  });
});
