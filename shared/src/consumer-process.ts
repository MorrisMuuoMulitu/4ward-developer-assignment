import 'dotenv/config';

import { connect } from 'amqplib';

import type { CityGroupJoinedEvent } from './contracts.js';
import { parseRuntimeConfig } from './config.js';
import { createMessageLogger } from './logger.js';
import { declareConsumerTopology, startQueueConsumer } from './rabbit-consumer.js';
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
    topology,
  });

  await new Promise<void>((resolve, reject) => {
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      logger.info({ signal }, 'Shutting down consumer');
      await subscription.stop();
      await channel.close();
      await connection.close();
      resolve();
    };

    process.once('SIGINT', () => {
      void shutdown('SIGINT').catch(reject);
    });
    process.once('SIGTERM', () => {
      void shutdown('SIGTERM').catch(reject);
    });
    channel.on('close', () => {
      resolve();
    });
  });
}
