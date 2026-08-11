// examples/test/smoke-harness.mjs
import { spawn } from "node:child_process";

/**
 * Start an example server and wait until it's listening on the given port.
 * Returns the child process and a stop() function.
 */
export function startExample(name, env) {
  const child = spawn("node", [`examples/${name}/src/index.mjs`], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (d) => stdout.push(d));
  child.stderr.on("data", (d) => stderr.push(d));

  return {
    child,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    stop() {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
    async stopAndWait(timeoutMs = 5_000) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/**
 * Wait for a port to be accepting connections.
 */
export async function waitForPort(port, timeoutMs = 10_000) {
  const net = await import("node:net");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
        socket.once("timeout", () => {
          socket.destroy();
          reject(new Error("timeout"));
        });
        socket.connect(port, "127.0.0.1");
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Port ${port} did not open within ${timeoutMs}ms`);
}

/**
 * Fetch a URL and return { status, body }.
 */
export async function fetchUrl(url) {
  const res = await fetch(url);
  const body = await res.text();
  return { status: res.status, body, contentType: res.headers.get("content-type") };
}
