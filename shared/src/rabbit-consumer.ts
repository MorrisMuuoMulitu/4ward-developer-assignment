import { randomUUID } from 'node:crypto';

import type { ConfirmChannel } from 'amqplib';

import {
  processConsumerMessage,
  type ConfirmedQueuePublisher,
  type MessageLogger,
  type QueuePublishOptions,
} from './consumer-runtime.js';
import type { CityGroupJoinedEvent } from './contracts.js';
import { RetryableError } from './errors.js';
import { confirmChannelAdapter, type ConfirmChannelLike } from './rabbit-publisher.js';
import { createDeadline, type Deadline } from './shutdown.js';
import type { ConsumerTopology } from './topology.js';

interface StartConsumerOptions {
  readonly channel: ConfirmChannel;
  readonly handler: (event: CityGroupJoinedEvent) => Promise<void>;
  readonly logger: MessageLogger;
  readonly maxRetryAttempts: number;
  readonly prefetch: number;
  readonly retryInitialDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly shutdownTimeoutMs: number;
  readonly topology: ConsumerTopology;
}

export interface QueueSubscription {
  readonly consumerTag: string;
  disableSettlement(): void;
  stop(deadline?: Deadline): Promise<void>;
}

export type QueueConfirmChannelLike = ConfirmChannelLike;

interface PendingQueuePublication {
  returned: boolean;
  readonly reject: (error: Error) => void;
}

function normalizePublicationError(error: unknown): Error {
  return error instanceof Error ? error : new Error('RabbitMQ publication failed.');
}

function confirmationFailure(error: Error): RetryableError {
  return new RetryableError('RabbitMQ rejected the publication confirmation.', {
    cause: error,
  });
}

export function createConfirmedQueuePublisher(
  channel: QueueConfirmChannelLike,
  correlationIdFactory: () => string = randomUUID,
): ConfirmedQueuePublisher {
  const pendingPublications = new Map<string, PendingQueuePublication>();

  channel.onReturn((message) => {
    const pending =
      message.messageId === undefined ? undefined : pendingPublications.get(message.messageId);
    if (pending !== undefined) {
      pending.returned = true;
    }
  });
  const rejectPending = (cause?: Error): void => {
    const error = new RetryableError(
      'RabbitMQ channel is unavailable during publication.',
      cause === undefined ? undefined : { cause },
    );
    for (const pending of pendingPublications.values()) {
      pending.reject(error);
    }
    pendingPublications.clear();
  };
  channel.onClose(() => {
    rejectPending();
  });
  channel.onError((error) => {
    rejectPending(error);
  });

  return {
    publish: async (
      queue: string,
      body: Buffer,
      headers: Readonly<Record<string, unknown>>,
      options: QueuePublishOptions,
    ) => {
      const messageId = correlationIdFactory();
      let pending: PendingQueuePublication | undefined;

      try {
        await new Promise<void>((resolve, reject) => {
          pending = {
            reject,
            returned: false,
          };
          pendingPublications.set(messageId, pending);

          try {
            channel.publish(
              '',
              queue,
              body,
              {
                ...options,
                headers,
                mandatory: true,
                messageId,
                persistent: true,
              },
              (error) => {
                if (error === null) {
                  resolve();
                } else {
                  reject(confirmationFailure(error));
                }
              },
            );
          } catch (error) {
            reject(
              new RetryableError('RabbitMQ confirmation publication failed synchronously.', {
                cause: normalizePublicationError(error),
              }),
            );
          }
        });

        if (pending?.returned === true) {
          throw new RetryableError(
            'RabbitMQ could not route the confirmation message to its queue.',
          );
        }
      } finally {
        pendingPublications.delete(messageId);
      }
    },
  };
}

export interface SettlementChannel<TMessage> {
  ack(message: TMessage): void;
  nack(message: TMessage, allUpTo: boolean, requeue: boolean): void;
}

export interface SettlementGuard {
  canSettle(): boolean;
  ack(): void;
  nack(requeue: boolean): void;
}

export function createSettlementGuard<TMessage>(
  channel: SettlementChannel<TMessage>,
  message: TMessage,
  isChannelOpen: () => boolean,
): SettlementGuard {
  return {
    canSettle: isChannelOpen,
    ack: () => {
      if (isChannelOpen()) {
        channel.ack(message);
      }
    },
    nack: (requeue) => {
      if (isChannelOpen()) {
        channel.nack(message, false, requeue);
      }
    },
  };
}

/**
 * Creates durable independent queues. Retry messages expire through the default exchange
 * back into their destination's main queue.
 */
export async function declareConsumerTopology(
  channel: ConfirmChannel,
  topology: ConsumerTopology,
): Promise<void> {
  await channel.assertExchange(topology.exchange, 'topic', { durable: true });
  await channel.assertQueue(topology.queues.main, { durable: true });
  await channel.bindQueue(topology.queues.main, topology.exchange, topology.routingKey);
  await channel.assertQueue(topology.queues.retry, {
    arguments: {
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': topology.queues.main,
    },
    durable: true,
  });
  await channel.assertQueue(topology.queues.deadLetter, { durable: true });
}

export async function startQueueConsumer(
  options: StartConsumerOptions,
): Promise<QueueSubscription> {
  const { channel, handler, logger, topology } = options;
  const publisher = createConfirmedQueuePublisher(confirmChannelAdapter(channel));
  const inFlight = new Set<Promise<void>>();
  let channelOpen = true;
  let accepting = true;
  let settlementDisabled = false;
  let shutdownDeadline: Deadline | undefined;
  const canSettle = (): boolean =>
    channelOpen &&
    !settlementDisabled &&
    (shutdownDeadline === undefined || shutdownDeadline.remainingMs() > 0);
  channel.once('close', () => {
    channelOpen = false;
  });
  await channel.prefetch(options.prefetch);

  const result = await channel.consume(
    topology.queues.main,
    (message) => {
      if (message === null) {
        return;
      }

      const settlement = createSettlementGuard(channel, message, canSettle);
      if (!accepting) {
        settlement.nack(true);
        return;
      }

      const processing = processConsumerMessage({
        delivery: {
          ack: () => {
            settlement.ack();
          },
          body: message.content,
          headers: message.properties.headers ?? {},
          nack: (requeue) => {
            settlement.nack(requeue);
          },
        },
        handler,
        logger,
        maxRetryAttempts: options.maxRetryAttempts,
        publisher,
        queues: topology.queues,
        retryInitialDelayMs: options.retryInitialDelayMs,
        retryMaxDelayMs: options.retryMaxDelayMs,
      })
        .then(() => undefined)
        .catch((error: unknown) => {
          logger.error(
            {
              errorType: error instanceof Error ? error.name : 'UnknownError',
              queue: topology.queues.main,
            },
            'Unexpected consumer runtime failure',
          );
          settlement.nack(true);
        })
        .finally(() => {
          inFlight.delete(processing);
        });
      inFlight.add(processing);
    },
    { noAck: false },
  );

  logger.info(
    {
      consumerTag: result.consumerTag,
      queue: topology.queues.main,
    },
    'Consumer subscribed',
  );

  let stopPromise: Promise<void> | undefined;

  return {
    consumerTag: result.consumerTag,
    disableSettlement: () => {
      settlementDisabled = true;
    },
    stop: (deadline = createDeadline(options.shutdownTimeoutMs)) => {
      stopPromise ??= (async () => {
        accepting = false;
        shutdownDeadline ??= deadline;

        if (channelOpen) {
          const cancelled = await deadline
            .run(async () => {
              await channel.cancel(result.consumerTag);
            })
            .catch((error: unknown) => {
              logger.error(
                {
                  errorType: error instanceof Error ? error.name : 'UnknownError',
                  queue: topology.queues.main,
                },
                'Consumer subscription cancellation failed',
              );
              return false;
            });

          if (!cancelled) {
            logger.error(
              {
                queue: topology.queues.main,
                timeoutMs: options.shutdownTimeoutMs,
              },
              'Consumer subscription cancellation exceeded the shutdown deadline',
            );
          }
        }

        const drained =
          inFlight.size === 0 ||
          (await deadline
            .run(async () => {
              await Promise.allSettled([...inFlight]);
            })
            .catch((error: unknown) => {
              logger.error(
                {
                  errorType: error instanceof Error ? error.name : 'UnknownError',
                  queue: topology.queues.main,
                },
                'In-flight delivery drain failed',
              );
              return false;
            }));
        if (!drained) {
          logger.error(
            {
              inFlightCount: inFlight.size,
              queue: topology.queues.main,
              timeoutMs: options.shutdownTimeoutMs,
            },
            'Shutdown deadline reached before in-flight deliveries completed',
          );
        }
      })();

      return stopPromise;
    },
  };
}
