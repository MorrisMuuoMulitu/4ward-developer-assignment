import { describe, expect, it } from 'vitest';

import { createCityGroupJoinedEvent } from '../src/contracts.js';
import {
  RabbitEventPublisher,
  type ConfirmChannelLike,
  type ReturnedMessage,
} from '../src/rabbit-publisher.js';

interface PublishOptions {
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly mandatory?: boolean;
  readonly messageId?: string;
  readonly persistent?: boolean;
}

class RecordingConfirmChannel implements ConfirmChannelLike {
  public onReturnRegistrations = 0;
  public readonly publishes: {
    readonly exchange: string;
    readonly options: PublishOptions;
    readonly routingKey: string;
  }[] = [];
  public readonly returnedMessageIds = new Set<string>();
  private readonly callbacks = new Map<string, (error: Error | null) => void>();
  private readonly closeListeners: (() => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];
  private readonly returnListeners: ((message: ReturnedMessage) => void)[] = [];

  public constructor(private readonly autoConfirm = true) {}

  public publish(
    exchange: string,
    routingKey: string,
    _content: Buffer,
    options: PublishOptions,
    callback: (error: Error | null) => void,
  ): boolean {
    this.publishes.push({ exchange, options, routingKey });
    const messageId = options.messageId ?? '';
    this.callbacks.set(messageId, callback);

    if (this.returnedMessageIds.has(messageId)) {
      for (const listener of this.returnListeners) {
        listener({ messageId });
      }
    }

    if (this.autoConfirm) {
      queueMicrotask(() => {
        this.confirm(messageId, null);
      });
    }

    return true;
  }

  public confirm(messageId: string, error: Error | null): void {
    const callback = this.callbacks.get(messageId);
    this.callbacks.delete(messageId);
    callback?.(error);
  }

  public onReturn(listener: (message: ReturnedMessage) => void): void {
    this.onReturnRegistrations += 1;
    this.returnListeners.push(listener);
  }

  public onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  public onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  public emitClose(): void {
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  public emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

function event() {
  return createCityGroupJoinedEvent(
    {
      name: 'Jane Doe',
      email: 'jane@example.com',
      city: 'London',
      country: 'United Kingdom',
      interests: ['Technology'],
    },
    {
      eventId: '7eec8d9b-ee33-4bdf-a63c-0bd9377fbde6',
      now: new Date('2026-11-16T10:30:00.000Z'),
    },
  );
}

describe('RabbitEventPublisher', () => {
  it('uses a unique attempt message ID while keeping the event ID in the payload', async () => {
    const channel = new RecordingConfirmChannel();
    const correlationIds = ['attempt-1', 'attempt-2'];
    const publisher = new RabbitEventPublisher(
      channel,
      'city-group.events',
      () => correlationIds.shift() ?? 'unexpected',
    );
    const cityGroupEvent = event();

    await publisher.publish(cityGroupEvent);
    await publisher.publish(cityGroupEvent);

    expect(channel.publishes).toHaveLength(2);
    expect(channel.publishes.map((publish) => publish.options)).toEqual([
      { mandatory: true, messageId: 'attempt-1', persistent: true },
      { mandatory: true, messageId: 'attempt-2', persistent: true },
    ]);
    expect(channel.publishes[0]?.options.messageId).not.toBe(cityGroupEvent.eventId);
    expect(channel.onReturnRegistrations).toBe(1);
  });

  it('correlates concurrent publications of the same event when one is returned', async () => {
    const channel = new RecordingConfirmChannel(false);
    const correlationIds = ['attempt-1', 'attempt-2'];
    const publisher = new RabbitEventPublisher(
      channel,
      'city-group.events',
      () => correlationIds.shift() ?? 'unexpected',
    );
    const cityGroupEvent = event();
    channel.returnedMessageIds.add('attempt-1');

    const firstPublish = publisher.publish(cityGroupEvent);
    const secondPublish = publisher.publish(cityGroupEvent);
    channel.confirm('attempt-1', null);
    channel.confirm('attempt-2', null);
    const results = await Promise.allSettled([firstPublish, secondPublish]);

    expect(results[0]).toMatchObject({
      reason: { name: 'RetryableError' },
      status: 'rejected',
    });
    expect(results[1]).toEqual({ status: 'fulfilled', value: undefined });
  });

  it('cleans tracking state after a returned publication', async () => {
    const channel = new RecordingConfirmChannel();
    const correlationIds = ['attempt-1', 'attempt-1'];
    const publisher = new RabbitEventPublisher(
      channel,
      'city-group.events',
      () => correlationIds.shift() ?? 'unexpected',
    );
    const cityGroupEvent = event();
    channel.returnedMessageIds.add('attempt-1');

    await expect(publisher.publish(cityGroupEvent)).rejects.toMatchObject({
      message: 'RabbitMQ could not route the event to a destination queue.',
      name: 'RetryableError',
    });

    channel.returnedMessageIds.clear();
    await expect(publisher.publish(cityGroupEvent)).resolves.toBeUndefined();
  });

  it('rejects a publication on negative confirm', async () => {
    const channel = new RecordingConfirmChannel(false);
    const publisher = new RabbitEventPublisher(channel, 'city-group.events', () => 'attempt-1');
    const publishing = publisher.publish(event());
    const confirmError = new Error('negative confirm');
    channel.confirm('attempt-1', confirmError);

    const error: unknown = await publishing.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      cause: confirmError,
      message: 'RabbitMQ rejected the publication confirmation.',
      name: 'RetryableError',
    });
  });

  it('rejects pending publications and marks unavailable on channel close or error', async () => {
    const closeChannel = new RecordingConfirmChannel(false);
    const closedPublisher = new RabbitEventPublisher(
      closeChannel,
      'city-group.events',
      () => 'close-attempt',
    );
    const closing = closedPublisher.publish(event());
    closeChannel.emitClose();

    await expect(closing).rejects.toMatchObject({ name: 'RetryableError' });
    expect(closedPublisher.isReady()).toBe(false);

    const errorChannel = new RecordingConfirmChannel(false);
    const failedPublisher = new RabbitEventPublisher(
      errorChannel,
      'city-group.events',
      () => 'error-attempt',
    );
    const failing = failedPublisher.publish(event());
    errorChannel.emitError(new Error('channel failed'));

    await expect(failing).rejects.toMatchObject({ name: 'RetryableError' });
    expect(failedPublisher.isReady()).toBe(false);
  });
});
