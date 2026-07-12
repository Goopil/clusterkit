/**
 * Type augmentation for Node.js net module.
 * Adds the `reusePort` option which is not included in @types/node.
 */

declare module "node:net" {
  interface ListenOptions {
    /**
     * Enable SO_REUSEPORT socket option (Linux 3.9+, macOS/BSD).
     * Allows multiple processes to bind to the same port with kernel-level load balancing.
     * @default false
     */
    reusePort?: boolean;
  }
}

export {};
