import type { ConfirmChannel, ConsumeMessage } from 'amqplib';

import {
  processConsumerMessage,
  type ConfirmedQueuePublisher,
  type ConsumerDelivery,
  type MessageLogger,
  type QueuePublishOptions,
} from './consumer-runtime.js';
import type { CityGroupJoinedEvent } from './contracts.js';
import type { ConsumerTopology } from './topology.js';

interface StartConsumerOptions {
  readonly channel: ConfirmChannel;
  readonly handler: (event: CityGroupJoinedEvent) => Promise<void>;
  readonly logger: MessageLogger;
  readonly maxRetryAttempts: number;
  readonly prefetch: number;
  readonly retryInitialDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly topology: ConsumerTopology;
}

export interface QueueSubscription {
  readonly consumerTag: string;
  stop(): Promise<void>;
}

function createConfirmedQueuePublisher(channel: ConfirmChannel): ConfirmedQueuePublisher {
  return {
    publish: (
      queue: string,
      body: Buffer,
      headers: Readonly<Record<string, unknown>>,
      options: QueuePublishOptions,
    ) =>
      new Promise<void>((resolve, reject) => {
        channel.publish(
          '',
          queue,
          body,
          {
            ...options,
            headers,
          },
          (error) => {
            if (error === undefined || error === null) {
              resolve();
            } else {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        );
      }),
  };
}

function deliveryFor(channel: ConfirmChannel, message: ConsumeMessage): ConsumerDelivery {
  return {
    ack: () => {
      channel.ack(message);
    },
    body: message.content,
    headers: message.properties.headers ?? {},
    nack: (requeue) => {
      channel.nack(message, false, requeue);
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
  const publisher = createConfirmedQueuePublisher(channel);
  const inFlight = new Set<Promise<void>>();
  let channelOpen = true;
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

      const processing = processConsumerMessage({
        delivery: deliveryFor(channel, message),
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
          if (channelOpen) {
            channel.nack(message, false, true);
          }
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
    stop: () => {
      stopPromise ??= (async () => {
        if (channelOpen) {
          await channel.cancel(result.consumerTag);
        }

        while (inFlight.size > 0) {
          await Promise.allSettled([...inFlight]);
        }
      })();

      return stopPromise;
    },
  };
}
