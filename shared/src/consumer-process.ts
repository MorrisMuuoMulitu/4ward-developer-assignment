import 'dotenv/config';

import { connect } from 'amqplib';

import type { CityGroupJoinedEvent } from './contracts.js';
import { parseRuntimeConfig } from './config.js';
import { createMessageLogger } from './logger.js';
import { declareConsumerTopology, startQueueConsumer } from './rabbit-consumer.js';
import { createDeadline, createIdempotentShutdown } from './shutdown.js';
import { topologyFor, type ConsumerDestination } from './topology.js';

export interface ConsumerProcessOptions {
  readonly destination: ConsumerDestination;
  readonly handler: (event: CityGroupJoinedEvent) => Promise<void>;
}

/**
 * Boots one destination consumer in isolation and owns process-level cleanup.
 */
export async function runConsumerProcess(options: ConsumerProcessOptions): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const logger = createMessageLogger(config.logLevel, `${options.destination}-consumer`);
  const connection = await connect(config.rabbitmq.url);
  const channel = await connection.createConfirmChannel();
  const topology = topologyFor(config.rabbitmq.exchange, options.destination);

  await declareConsumerTopology(channel, topology);
  const subscription = await startQueueConsumer({
    channel,
    handler: options.handler,
    logger,
    maxRetryAttempts: config.retry.maxAttempts,
    prefetch: config.consumerPrefetch,
    retryInitialDelayMs: config.retry.initialDelayMs,
    retryMaxDelayMs: config.retry.maxDelayMs,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    topology,
  });

  let channelOpen = true;
  let connectionOpen = true;
  let intentionalShutdown = false;
  let stoppedResolved = false;
  let resolveStopped = (): void => undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const settleStopped = (): void => {
    if (!stoppedResolved) {
      stoppedResolved = true;
      resolveStopped();
    }
  };

  const shutdown = createIdempotentShutdown(async (reason) => {
    intentionalShutdown = true;
    logger.info({ signal: reason }, 'Shutting down consumer');
    const deadline = createDeadline(config.shutdownTimeoutMs);

    try {
      await subscription.stop(deadline);
    } catch (error) {
      logger.error(
        {
          errorType: error instanceof Error ? error.name : 'UnknownError',
          queue: topology.queues.main,
        },
        'Consumer subscription shutdown failed',
      );
    }

    if (channelOpen) {
      channelOpen = false;
      try {
        const closed = await deadline.run(async () => {
          await channel.close();
        });
        if (!closed) {
          logger.error(
            {
              operation: 'channel.close',
              timeoutMs: config.shutdownTimeoutMs,
            },
            'RabbitMQ channel close exceeded the shutdown deadline',
          );
        }
      } catch (error) {
        logger.error(
          {
            errorType: error instanceof Error ? error.name : 'UnknownError',
            queue: topology.queues.main,
          },
          'RabbitMQ channel close failed during shutdown',
        );
      }
    }

    if (connectionOpen) {
      connectionOpen = false;
      try {
        const closed = await deadline.run(async () => {
          await connection.close();
        });
        if (!closed) {
          logger.error(
            {
              operation: 'connection.close',
              timeoutMs: config.shutdownTimeoutMs,
            },
            'RabbitMQ connection close exceeded the shutdown deadline',
          );
        }
      } catch (error) {
        logger.error(
          {
            errorType: error instanceof Error ? error.name : 'UnknownError',
          },
          'RabbitMQ connection close failed during shutdown',
        );
      }
    }

    settleStopped();
  });
  const requestShutdown = (reason: string): void => {
    void shutdown(reason).catch((error: unknown) => {
      logger.error(
        {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        },
        'Consumer shutdown failed',
      );
      settleStopped();
    });
  };

  process.once('SIGINT', () => {
    requestShutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    requestShutdown('SIGTERM');
  });
  channel.on('error', (error) => {
    subscription.disableSettlement();
    logger.error(
      {
        errorType: error.name,
        queue: topology.queues.main,
      },
      'RabbitMQ channel error',
    );
    requestShutdown('channel-error');
  });
  channel.on('close', () => {
    channelOpen = false;
    subscription.disableSettlement();
    if (!intentionalShutdown) {
      logger.error({ queue: topology.queues.main }, 'RabbitMQ channel closed unexpectedly');
    }
    requestShutdown('channel-close');
  });
  connection.on('error', (error) => {
    subscription.disableSettlement();
    logger.error(
      {
        errorType: error.name,
      },
      'RabbitMQ connection error',
    );
    requestShutdown('connection-error');
  });
  connection.on('close', () => {
    connectionOpen = false;
    subscription.disableSettlement();
    if (!intentionalShutdown) {
      logger.error({}, 'RabbitMQ connection closed unexpectedly');
    }
    requestShutdown('connection-close');
  });

  await stopped;
}
