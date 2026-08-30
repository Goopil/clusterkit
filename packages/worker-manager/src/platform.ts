import { createServer } from "node:net";
import { release } from "node:os";

// ============================================================================
// Cache — resettable for tests
// ============================================================================

let cachedReusePortSupport: boolean | undefined;
let detectionPromise: Promise<boolean> | undefined;

/** @internal — test only */
export function _resetDetectionCache(): void {
  cachedReusePortSupport = undefined;
  detectionPromise = undefined;
}

/**
 * Reads the cached SO_REUSEPORT detection result synchronously.
 * Returns `undefined` if detection has not yet been performed
 * (i.e. `detectReusePortSupport()` was never awaited).
 */
export function getReusePortCached(): boolean | undefined {
  return cachedReusePortSupport;
}

// ============================================================================
// Detection
// ============================================================================

function parseKernelVersion(versionString: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)/.exec(versionString);
  if (!match) return null;
  return { major: Number.parseInt(match[1], 10), minor: Number.parseInt(match[2], 10) };
}

/**
 * Attempts to bind TWO servers on the same port with SO_REUSEPORT to detect
 * runtime support. Node < 22.12 silently ignores the `reusePort` listen
 * option, so a single successful bind proves nothing — only a second bind on
 * the same port can distinguish "flag honored" from "flag ignored".
 * Event-driven — no polling.
 */
function detectRuntimeReusePortSupport(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const first = createServer();
    const second = createServer();
    let settled = false;

    const cleanup = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const server of [first, second]) {
        server.removeAllListeners();
        // A late async error on a closing socket must not crash the process
        server.on("error", () => {});
        try {
          server.close();
          server.unref();
        } catch {
          /* already closed */
        }
      }
      resolve(result);
    };

    // Safety timeout — must not block startup. Generous enough that a
    // CPU-starved host (throttled pod at boot) does not cache a false negative
    // for the whole process lifetime.
    const timer = setTimeout(() => cleanup(false), 500);

    first.once("error", () => cleanup(false));
    second.once("error", () => cleanup(false));

    first.once("listening", () => {
      const address = first.address();
      if (address === null || typeof address === "string") {
        cleanup(false);
        return;
      }

      second.once("listening", () => cleanup(true));
      try {
        second.listen({ port: address.port, host: "127.0.0.1", reusePort: true });
      } catch {
        cleanup(false);
      }
    });

    try {
      first.listen({
        port: 0,
        host: "127.0.0.1",
        reusePort: true,
      });
    } catch {
      cleanup(false);
    }
  });
}

/**
 * Detects whether SO_REUSEPORT is supported on the current platform.
 * Result is cached — the call is idempotent.
 */
export async function detectReusePortSupport(): Promise<boolean> {
  if (cachedReusePortSupport !== undefined) return cachedReusePortSupport;
  if (detectionPromise) return detectionPromise;

  detectionPromise = (async () => {
    try {
      // Windows does not support SO_REUSEPORT
      if (process.platform === "win32") {
        cachedReusePortSupport = false;
        return false;
      }

      // macOS supports the SO_REUSEPORT flag but does not distribute connections
      // across sockets — the last socket to bind steals all traffic.
      // Treat it as unsupported so workers fall back to cluster round-robin.
      if (process.platform === "darwin") {
        cachedReusePortSupport = false;
        return false;
      }

      // Linux: fast check by kernel version (SO_REUSEPORT available since 3.9)
      if (process.platform === "linux") {
        const parsed = parseKernelVersion(release());
        if (parsed) {
          const supported = parsed.major > 3 || (parsed.major === 3 && parsed.minor >= 9);
          if (!supported) {
            cachedReusePortSupport = false;
            return false;
          }
          // Kernel >= 3.9 — confirm via runtime (some distros patch this behaviour)
        }
      }

      // macOS/BSD + Linux >= 3.9: runtime detection
      cachedReusePortSupport = await detectRuntimeReusePortSupport();
      return cachedReusePortSupport;
    } catch (err) {
      // Cache a safe default so the call stays idempotent on the error path
      // — without this, cachedReusePortSupport stays undefined and every
      // subsequent caller re-runs detection (and re-throws) indefinitely.
      if (err instanceof Error) {
        process.stderr.write(`SO_REUSEPORT detection failed: ${err.message}\n`);
      }
      cachedReusePortSupport = false;
      return false;
    } finally {
      detectionPromise = undefined;
    }
  })();

  return detectionPromise;
}

// ============================================================================
// Capabilities
// ============================================================================

export interface PlatformCapabilities {
  platform: NodeJS.Platform;
  reusePort: boolean;
  clusterRecommended: boolean;
}

export async function getPlatformCapabilities(): Promise<PlatformCapabilities> {
  const reusePort = await detectReusePortSupport();
  return {
    platform: process.platform,
    reusePort,
    clusterRecommended: reusePort,
  };
}
