import { performance } from 'node:perf_hooks';

export type ShutdownOperation = (reason: string) => Promise<void>;

export interface Deadline {
  remainingMs(): number;
  run(operation: () => Promise<void>): Promise<boolean>;
}

/**
 * Creates one monotonic budget shared by every step of a shutdown sequence.
 */
export function createDeadline(timeoutMs: number): Deadline {
  const expiresAt = performance.now() + timeoutMs;
  let expired = false;

  return {
    remainingMs: () => (expired ? 0 : Math.max(0, expiresAt - performance.now())),
    run: async (operation) => {
      const remainingMs = Math.max(0, expiresAt - performance.now());

      if (remainingMs === 0) {
        expired = true;
        void Promise.resolve()
          .then(operation)
          .catch(() => undefined);
        return false;
      }

      const operationResult = operation().then(() => true);

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(false);
        }, remainingMs);
        timer.unref();
      });

      try {
        return await Promise.race([operationResult, timeout]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}

/**
 * Ensures concurrent signal handlers share one shutdown operation.
 */
export function createIdempotentShutdown(
  operation: ShutdownOperation,
): (reason: string) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return (reason) => {
    shutdownPromise ??= operation(reason);
    return shutdownPromise;
  };
}
