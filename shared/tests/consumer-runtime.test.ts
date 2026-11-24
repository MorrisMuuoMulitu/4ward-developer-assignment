import { describe, expect, it } from 'vitest';

import type { CityGroupJoinedEvent } from '../src/contracts.js';
import {
  RETRY_COUNT_HEADER,
  calculateRetryDelayMs,
  processConsumerMessage,
  type ConfirmedQueuePublisher,
  type ConsumerDelivery,
  type ConsumerQueueNames,
  type MessageLogger,
  type QueuePublishOptions,
} from '../src/consumer-runtime.js';
import { RetryableError, TerminalError } from '../src/errors.js';

const queues: ConsumerQueueNames = {
  main: 'city-group.events.airtable',
  retry: 'city-group.events.airtable.retry',
  deadLetter: 'city-group.events.airtable.dlq',
};

const event: CityGroupJoinedEvent = {
  event: 'CityGroupJoined',
  eventId: '7eec8d9b-ee33-4bdf-a63c-0bd9377fbde6',
  timestamp: '2026-11-16T10:30:00.000Z',
  data: {
    name: 'Jane Doe',
    email: 'jane@example.com',
    city: 'London',
    country: 'United Kingdom',
    interests: ['Technology'],
  },
};

const logger: MessageLogger = {
  error: () => undefined,
  info: () => undefined,
};

class RecordingPublisher implements ConfirmedQueuePublisher {
  public readonly calls: {
    readonly body: string;
    readonly headers: Readonly<Record<string, unknown>>;
    readonly options: QueuePublishOptions;
    readonly queue: string;
  }[] = [];

  public publish(
    queue: string,
    body: Buffer,
    headers: Readonly<Record<string, unknown>>,
    options: QueuePublishOptions,
  ): Promise<void> {
    this.calls.push({ body: body.toString('utf8'), headers, options, queue });
    return Promise.resolve();
  }
}

function delivery(
  headers: Readonly<Record<string, unknown>> = {},
): ConsumerDelivery & { readonly actions: string[] } {
  const actions: string[] = [];

  return {
    actions,
    ack: () => actions.push('ack'),
    body: Buffer.from(JSON.stringify(event)),
    headers,
    nack: (requeue) => actions.push(`nack:${String(requeue)}`),
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return {
    promise,
    resolve: () => {
      resolve?.();
    },
  };
}

const baseOptions = {
  logger,
  maxRetryAttempts: 2,
  queues,
  retryInitialDelayMs: 250,
  retryMaxDelayMs: 1000,
};

describe('consumer message processing', () => {
  it('acknowledges a successfully processed event', async () => {
    const message = delivery();
    const publisher = new RecordingPublisher();

    const outcome = await processConsumerMessage({
      ...baseOptions,
      delivery: message,
      handler: () => Promise.resolve(),
      publisher,
    });

    expect(outcome).toBe('success');
    expect(message.actions).toEqual(['ack']);
    expect(publisher.calls).toEqual([]);
  });

  it('routes a retryable failure and waits for confirmation before acknowledging', async () => {
    const message = delivery();
    const publication = deferred();
    const calls: string[] = [];
    const publisher: ConfirmedQueuePublisher = {
      publish: () => {
        calls.push('publish');
        return publication.promise;
      },
    };

    const processing = processConsumerMessage({
      ...baseOptions,
      delivery: message,
      handler: () => Promise.reject(new RetryableError('Temporary outage')),
      publisher,
    });

    await Promise.resolve();
    expect(calls).toEqual(['publish']);
    expect(message.actions).toEqual([]);

    publication.resolve();
    await expect(processing).resolves.toBe('retry');
    expect(message.actions).toEqual(['ack']);
  });

  it('moves an exhausted retryable failure to the dead-letter queue', async () => {
    const message = delivery({ [RETRY_COUNT_HEADER]: 2 });
    const publisher = new RecordingPublisher();

    const outcome = await processConsumerMessage({
      ...baseOptions,
      delivery: message,
      handler: () => Promise.reject(new RetryableError('Still unavailable')),
      publisher,
    });

    expect(outcome).toBe('dead-letter');
    expect(publisher.calls[0]?.queue).toBe(queues.deadLetter);
    expect(message.actions).toEqual(['ack']);
  });

  it('moves terminal failures directly to the dead-letter queue', async () => {
    const message = delivery();
    const publisher = new RecordingPublisher();

    const outcome = await processConsumerMessage({
      ...baseOptions,
      delivery: message,
      handler: () => Promise.reject(new TerminalError('Invalid credentials')),
      publisher,
    });

    expect(outcome).toBe('dead-letter');
    expect(publisher.calls[0]?.queue).toBe(queues.deadLetter);
    expect(publisher.calls[0]?.headers['x-error-type']).toBe('TerminalError');
    expect(message.actions).toEqual(['ack']);
  });

  it('dead-letters malformed event payloads without invoking the handler', async () => {
    const message = {
      ...delivery(),
      body: Buffer.from('{"event":"wrong"}'),
    };
    const publisher = new RecordingPublisher();
    let invoked = false;

    const outcome = await processConsumerMessage({
      ...baseOptions,
      delivery: message,
      handler: () => {
        invoked = true;
        return Promise.resolve();
      },
      publisher,
    });

    expect(outcome).toBe('dead-letter');
    expect(invoked).toBe(false);
    expect(publisher.calls[0]?.queue).toBe(queues.deadLetter);
    expect(message.actions).toEqual(['ack']);
  });

  it('requeues the original message when retry routing cannot be confirmed', async () => {
    const message = delivery();
    const publisher: ConfirmedQueuePublisher = {
      publish: () => Promise.reject(new RetryableError('Broker unavailable')),
    };

    const outcome = await processConsumerMessage({
      ...baseOptions,
      delivery: message,
      handler: () => Promise.reject(new RetryableError('Temporary outage')),
      publisher,
    });

    expect(outcome).toBe('requeued');
    expect(message.actions).toEqual(['nack:true']);
  });

  it('requeues the original message when DLQ routing cannot be confirmed', async () => {
    const message = delivery();
    const publisher: ConfirmedQueuePublisher = {
      publish: () => Promise.reject(new RetryableError('Queue is not bound')),
    };

    const outcome = await processConsumerMessage({
      ...baseOptions,
      delivery: message,
      handler: () => Promise.reject(new TerminalError('Permanent destination failure')),
      publisher,
    });

    expect(outcome).toBe('requeued');
    expect(message.actions).toEqual(['nack:true']);
  });

  it.each([
    ['negative number', -1],
    ['fractional number', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['NaN', Number.NaN],
    ['negative string', '-1'],
    ['fractional string', '1.5'],
    ['non-numeric string', 'invalid'],
    ['blank string', ''],
  ])('dead-letters invalid retry metadata: %s', async (_label, retryCount) => {
    const message = delivery({ [RETRY_COUNT_HEADER]: retryCount });
    const publisher = new RecordingPublisher();
    let invoked = false;

    const outcome = await processConsumerMessage({
      ...baseOptions,
      delivery: message,
      handler: () => {
        invoked = true;
        return Promise.resolve();
      },
      publisher,
    });

    expect(outcome).toBe('dead-letter');
    expect(invoked).toBe(false);
    expect(publisher.calls[0]?.queue).toBe(queues.deadLetter);
    expect(publisher.calls[0]?.headers).toMatchObject({
      'x-error-reason': 'invalid-retry-count',
      'x-error-type': 'InvalidRetryMetadataError',
    });
    expect(publisher.calls[0]?.headers[RETRY_COUNT_HEADER]).toBeUndefined();
    expect(message.actions).toEqual(['ack']);
  });

  it.each([
    [0, 1],
    [1, 2],
  ])('routes retry count %i to retry count %i before the maximum', async (retryCount, next) => {
    const message = delivery({ [RETRY_COUNT_HEADER]: retryCount });
    const publisher = new RecordingPublisher();

    const outcome = await processConsumerMessage({
      ...baseOptions,
      delivery: message,
      handler: () => Promise.reject(new RetryableError('Temporary outage')),
      publisher,
    });

    expect(outcome).toBe('retry');
    expect(publisher.calls[0]?.headers[RETRY_COUNT_HEADER]).toBe(next);
    expect(message.actions).toEqual(['ack']);
  });
});

describe('retry delay', () => {
  it('uses exponential backoff capped by the configured maximum', () => {
    expect(calculateRetryDelayMs(0, 250, 1000)).toBe(250);
    expect(calculateRetryDelayMs(1, 250, 1000)).toBe(500);
    expect(calculateRetryDelayMs(4, 250, 1000)).toBe(1000);
  });
});
