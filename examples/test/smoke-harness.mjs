// examples/test/smoke-harness.mjs
import { spawn } from "node:child_process";

/**
 * Start an example server and wait until it's listening on the given port.
 * Returns the child process and a stop() function.
 * `entry` overrides the default `examples/<name>/src/index.mjs` entry point
 * (e.g. built TypeScript examples like NestJS run from `dist/main.js`).
 */
export function startExample(name, env, entry = `examples/${name}/src/index.mjs`) {
  const child = spawn("node", [entry], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
    // Own process group so the whole tree (primary + cluster workers) can be
    // signalled: killing only the primary orphans its workers, which keep the
    // app ports bound and poison subsequent smoke runs.
    detached: true,
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (d) => stdout.push(d));
  child.stderr.on("data", (d) => stderr.push(d));

  const signalTree = (signal) => {
    if (!child.pid) return;
    try {
      // Negative pid = signal the whole process group (child is its own
      // group leader thanks to detached: true)
      process.kill(-child.pid, signal);
    } catch {
      // Group already gone, or child is not a group leader — fall back to
      // signalling the primary only
      try {
        child.kill(signal);
      } catch {
        /* already dead */
      }
    }
  };

  return {
    child,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    stop() {
      signalTree("SIGTERM");
    },
    async stopAndWait(timeoutMs = 5_000) {
      signalTree("SIGTERM");
      await new Promise((resolve) => {
        // Escalate to SIGKILL if graceful shutdown hangs past the timeout
        const killer = setTimeout(() => signalTree("SIGKILL"), timeoutMs);
        child.once("exit", () => {
          clearTimeout(killer);
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
