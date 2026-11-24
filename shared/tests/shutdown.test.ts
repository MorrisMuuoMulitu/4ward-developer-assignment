import { describe, expect, it } from 'vitest';

import { createDeadline, createIdempotentShutdown } from '../src/shutdown.js';

describe('idempotent shutdown', () => {
  it('executes concurrent shutdown requests once and returns the same promise', async () => {
    let calls = 0;
    let resolveShutdown = (): void => undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const shutdown = createIdempotentShutdown(async () => {
      calls += 1;
      await stopped;
    });

    const first = shutdown('SIGINT');
    const second = shutdown('SIGTERM');

    expect(first).toBe(second);
    expect(calls).toBe(1);
    resolveShutdown();
    await first;
  });

  it('reports whether an operation completed before the shared deadline', async () => {
    const deadline = createDeadline(80);

    await expect(deadline.run(() => Promise.resolve())).resolves.toBe(true);
    const completed = await deadline.run(() => new Promise<void>(() => undefined));

    expect(completed).toBe(false);
    expect(deadline.remainingMs()).toBe(0);
  });

  it('starts a close operation even when the deadline has already expired', async () => {
    const deadline = createDeadline(0);
    let started = false;

    await expect(
      deadline.run(() => {
        started = true;
        return Promise.resolve();
      }),
    ).resolves.toBe(false);
    await Promise.resolve();

    expect(started).toBe(true);
  });

  it('does not leak a rejection from an operation that finishes after timeout', async () => {
    const deadline = createDeadline(10);
    const completed = await deadline.run(
      () =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('late shutdown failure'));
          }, 20);
        }),
    );

    expect(completed).toBe(false);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
  });
});
