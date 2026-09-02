import { createServer } from "node:net";
import { release } from "node:os";

// ============================================================================
// Cache — resettable for tests
// ============================================================================

let cachedReusePortSupport: boolean | undefined;
let detectionPromise: Promise<boolean> | undefined;
let runtimeProbe: () => Promise<boolean> = detectRuntimeReusePortSupport;

/** @internal — test only */
export function _resetDetectionCache(): void {
  cachedReusePortSupport = undefined;
  detectionPromise = undefined;
}

/** @internal — test only: stub the runtime probe (undefined restores the real probe) */
export function _setRuntimeProbe(probe: (() => Promise<boolean>) | undefined): void {
  runtimeProbe = probe ?? detectRuntimeReusePortSupport;
}

/**
 * Thrown when the two-socket probe times out. The outcome is inconclusive —
 * not "unsupported" — so it must not be cached.
 * @internal — exported for tests
 */
export class ReusePortProbeTimeoutError extends Error {
  constructor() {
    super("SO_REUSEPORT probe timed out (inconclusive)");
    this.name = "ReusePortProbeTimeoutError";
  }
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
  return new Promise<boolean>((resolve, reject) => {
    const first = createServer();
    const second = createServer();
    let settled = false;

    const closeServers = (): void => {
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
    };

    const cleanup = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeServers();
      resolve(result);
    };

    // Safety timeout — must not block startup. Rejects as INCONCLUSIVE instead
    // of resolving false: a CPU-starved host (throttled pod at boot) must not
    // have a timeout cached as "unsupported" for the whole process lifetime.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeServers();
      reject(new ReusePortProbeTimeoutError());
    }, 500);

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
 * Definitive results are cached — the call is idempotent. An inconclusive
 * probe timeout is not cached (the next call re-probes).
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
      cachedReusePortSupport = await runtimeProbe();
      return cachedReusePortSupport;
    } catch (err) {
      if (err instanceof ReusePortProbeTimeoutError) {
        // Inconclusive — answer false for THIS call but leave the cache empty
        // so a later call re-probes (e.g. once a throttled boot settles down).
        return false;
      }
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
}

export async function getPlatformCapabilities(): Promise<PlatformCapabilities> {
  const reusePort = await detectReusePortSupport();
  return {
    platform: process.platform,
    reusePort,
  };
}
