import 'dotenv/config';

import { connect } from 'amqplib';

import { parseRuntimeConfig } from '../../shared/src/config.js';
import {
  EVENT_ROUTING_KEY,
  RabbitEventPublisher,
  type ConfirmChannelLike,
} from '../../shared/src/rabbit-publisher.js';
import { logStartupFailure } from '../../shared/src/logger.js';
import { createProducerApp } from './app.js';

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const connection = await connect(config.rabbitmq.url);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(config.rabbitmq.exchange, 'topic', { durable: true });

  const channelAdapter: ConfirmChannelLike = {
    publish: (exchange, routingKey, content, options) =>
      channel.publish(exchange, routingKey, content, options),
    waitForConfirms: () => channel.waitForConfirms(),
  };
  const publisher = new RabbitEventPublisher(channelAdapter, config.rabbitmq.exchange);
  const app = await createProducerApp({
    logger: { level: config.logLevel },
    publisher,
  });

  channel.on('close', () => {
    publisher.markUnavailable();
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'Shutting down producer');
    await app.close();
    await channel.close();
    await connection.close();
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT').catch((error: unknown) => {
      app.log.error({ err: error }, 'Producer shutdown failed');
      process.exitCode = 1;
    });
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').catch((error: unknown) => {
      app.log.error({ err: error }, 'Producer shutdown failed');
      process.exitCode = 1;
    });
  });

  await app.listen({ host: '0.0.0.0', port: config.port });
  app.log.info(
    {
      exchange: config.rabbitmq.exchange,
      routingKey: EVENT_ROUTING_KEY,
    },
    'Producer connected to RabbitMQ',
  );
}

main().catch((error: unknown) => {
  logStartupFailure('producer', error);
  process.exitCode = 1;
});
