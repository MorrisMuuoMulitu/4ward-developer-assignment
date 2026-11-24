import { randomUUID } from 'node:crypto';

import type { ConfirmChannel } from 'amqplib';

import type { CityGroupJoinedEvent } from './contracts.js';
import { RetryableError } from './errors.js';
import type { EventPublisher } from './publisher.js';

export const EVENT_ROUTING_KEY = 'city.group.joined';

export interface ReturnedMessage {
  readonly messageId: string | undefined;
}

export interface ConfirmChannelLike {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: {
      readonly headers?: Readonly<Record<string, unknown>>;
      readonly mandatory?: boolean;
      readonly messageId?: string;
      readonly persistent?: boolean;
    },
    callback: (error: Error | null) => void,
  ): boolean;
  onReturn(listener: (message: ReturnedMessage) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
}

interface PendingPublication {
  returned: boolean;
  readonly reject: (error: Error) => void;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('RabbitMQ publication failed.');
}

function confirmFailure(error: Error): RetryableError {
  return new RetryableError('RabbitMQ rejected the publication confirmation.', {
    cause: error,
  });
}

function confirmError(error: unknown): Error | null {
  if (error === null || error === undefined) {
    return null;
  }
  return normalizeError(error);
}

/**
 * Adapts amqplib's event and callback signatures without leaking `any` values.
 */
export function confirmChannelAdapter(channel: ConfirmChannel): ConfirmChannelLike {
  return {
    onClose: (listener) => {
      channel.once('close', listener);
    },
    onError: (listener) => {
      channel.on('error', listener);
    },
    onReturn: (listener) => {
      channel.on('return', (message) => {
        listener({
          messageId:
            typeof message.properties.messageId === 'string'
              ? message.properties.messageId
              : undefined,
        });
      });
    },
    publish: (exchange, routingKey, content, options, callback) =>
      channel.publish(exchange, routingKey, content, options, (error: unknown) => {
        callback(confirmError(error));
      }),
  };
}

/**
 * Publishes persistent mandatory messages and settles each attempt from its own confirm callback.
 */
export class RabbitEventPublisher implements EventPublisher {
  private ready = true;
  private readonly pendingPublications = new Map<string, PendingPublication>();

  public constructor(
    private readonly channel: ConfirmChannelLike,
    private readonly exchange: string,
    private readonly correlationIdFactory: () => string = randomUUID,
  ) {
    channel.onReturn((message) => {
      const pending =
        message.messageId === undefined
          ? undefined
          : this.pendingPublications.get(message.messageId);
      if (pending !== undefined) {
        pending.returned = true;
      }
    });
    channel.onClose(() => {
      this.markUnavailable('RabbitMQ channel closed during publication.');
    });
    channel.onError((error) => {
      this.markUnavailable('RabbitMQ channel error during publication.', error);
    });
  }

  public isReady(): boolean {
    return this.ready;
  }

  public async publish(event: CityGroupJoinedEvent): Promise<void> {
    if (!this.ready) {
      throw new RetryableError('RabbitMQ publisher is unavailable.');
    }

    const messageId = this.correlationIdFactory();
    let pending: PendingPublication | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        pending = {
          reject,
          returned: false,
        };
        this.pendingPublications.set(messageId, pending);

        try {
          this.channel.publish(
            this.exchange,
            EVENT_ROUTING_KEY,
            Buffer.from(JSON.stringify(event)),
            {
              mandatory: true,
              messageId,
              persistent: true,
            },
            (error) => {
              if (error === null) {
                resolve();
              } else {
                reject(confirmFailure(error));
              }
            },
          );
        } catch (error) {
          reject(
            new RetryableError('RabbitMQ publication failed synchronously.', {
              cause: normalizeError(error),
            }),
          );
        }
      });

      if (pending?.returned === true) {
        throw new RetryableError('RabbitMQ could not route the event to a destination queue.');
      }
    } finally {
      this.pendingPublications.delete(messageId);
    }
  }

  public markUnavailable(message = 'RabbitMQ publisher is unavailable.', cause?: Error): void {
    this.ready = false;
    const error = new RetryableError(message, cause === undefined ? undefined : { cause });
    for (const pending of this.pendingPublications.values()) {
      pending.reject(error);
    }
    this.pendingPublications.clear();
  }
}
