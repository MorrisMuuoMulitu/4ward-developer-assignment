import { describe, expect, it } from 'vitest';

import {
  createConfirmedQueuePublisher,
  type QueueConfirmChannelLike,
} from '../src/rabbit-consumer.js';
import type { ReturnedMessage } from '../src/rabbit-publisher.js';

class RecordingQueueChannel implements QueueConfirmChannelLike {
  public onReturnRegistrations = 0;
  public readonly returnedMessageIds = new Set<string>();
  public readonly publishes: {
    readonly body: string;
    readonly messageId: string | undefined;
    readonly queue: string;
  }[] = [];
  private readonly callbacks = new Map<string, (error: Error | null) => void>();
  private readonly closeListeners: (() => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];
  private readonly returnListeners: ((message: ReturnedMessage) => void)[] = [];

  public publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: {
      readonly mandatory?: boolean;
      readonly messageId?: string;
      readonly persistent?: boolean;
    },
    callback: (error: Error | null) => void,
  ): boolean {
    expect(exchange).toBe('');
    const messageId = options.messageId ?? '';
    this.publishes.push({
      body: content.toString('utf8'),
      messageId: options.messageId,
      queue: routingKey,
    });
    this.callbacks.set(messageId, callback);

    if (this.returnedMessageIds.has(messageId)) {
      for (const listener of this.returnListeners) {
        listener({ messageId });
      }
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

describe('confirmed queue publisher', () => {
  it('correlates concurrent queue publications when one is returned', async () => {
    const channel = new RecordingQueueChannel();
    const correlationIds = ['attempt-1', 'attempt-2'];
    const publisher = createConfirmedQueuePublisher(
      channel,
      () => correlationIds.shift() ?? 'unexpected',
    );
    channel.returnedMessageIds.add('attempt-1');

    const first = publisher.publish(
      'retry-queue',
      Buffer.from('{"eventId":"same-event"}'),
      {},
      { persistent: true },
    );
    const second = publisher.publish(
      'retry-queue',
      Buffer.from('{"eventId":"same-event"}'),
      {},
      { persistent: true },
    );
    channel.confirm('attempt-1', null);
    channel.confirm('attempt-2', null);
    const results = await Promise.allSettled([first, second]);

    expect(results[0]).toMatchObject({
      reason: { name: 'RetryableError' },
      status: 'rejected',
    });
    expect(results[1]).toEqual({ status: 'fulfilled', value: undefined });
    expect(channel.onReturnRegistrations).toBe(1);
    expect(channel.publishes.map((publish) => publish.messageId)).toEqual([
      'attempt-1',
      'attempt-2',
    ]);
  });

  it('rejects negative confirms and cleans tracking state before reusing an ID', async () => {
    const channel = new RecordingQueueChannel();
    const correlationIds = ['attempt-1', 'attempt-1'];
    const publisher = createConfirmedQueuePublisher(
      channel,
      () => correlationIds.shift() ?? 'unexpected',
    );

    const first = publisher.publish('dlq', Buffer.from('{}'), {}, { persistent: true });
    const confirmError = new Error('negative confirm');
    channel.confirm('attempt-1', confirmError);
    const error: unknown = await first.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      cause: confirmError,
      message: 'RabbitMQ rejected the publication confirmation.',
      name: 'RetryableError',
    });

    const second = publisher.publish('dlq', Buffer.from('{}'), {}, { persistent: true });
    channel.confirm('attempt-1', null);
    await expect(second).resolves.toBeUndefined();
  });

  it('rejects pending publications on channel close and error', async () => {
    const closeChannel = new RecordingQueueChannel();
    const closePublisher = createConfirmedQueuePublisher(closeChannel, () => 'close-attempt');
    const closing = closePublisher.publish('queue', Buffer.from('{}'), {}, { persistent: true });
    closeChannel.emitClose();
    await expect(closing).rejects.toMatchObject({ name: 'RetryableError' });

    const errorChannel = new RecordingQueueChannel();
    const errorPublisher = createConfirmedQueuePublisher(errorChannel, () => 'error-attempt');
    const failing = errorPublisher.publish('queue', Buffer.from('{}'), {}, { persistent: true });
    errorChannel.emitError(new Error('channel failed'));
    await expect(failing).rejects.toMatchObject({ name: 'RetryableError' });
  });
});
