import 'dotenv/config';

import { connect } from 'amqplib';

import { parseRuntimeConfig } from '../../shared/src/config.js';
import {
  confirmChannelAdapter,
  EVENT_ROUTING_KEY,
  RabbitEventPublisher,
} from '../../shared/src/rabbit-publisher.js';
import { logStartupFailure } from '../../shared/src/logger.js';
import { createDeadline, createIdempotentShutdown } from '../../shared/src/shutdown.js';
import { createProducerApp } from './app.js';

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const connection = await connect(config.rabbitmq.url);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(config.rabbitmq.exchange, 'topic', { durable: true });

  const publisher = new RabbitEventPublisher(
    confirmChannelAdapter(channel),
    config.rabbitmq.exchange,
  );
  const app = await createProducerApp({
    logger: { level: config.logLevel },
    publisher,
  });

  let channelOpen = true;
  let connectionOpen = true;
  let intentionalShutdown = false;

  channel.on('close', () => {
    channelOpen = false;
    if (!intentionalShutdown) {
      app.log.error('RabbitMQ channel closed unexpectedly');
    }
  });
  channel.on('error', (error) => {
    publisher.markUnavailable();
    app.log.error({ errorType: error.name }, 'RabbitMQ channel error');
  });
  connection.on('close', () => {
    connectionOpen = false;
    publisher.markUnavailable();
    if (!intentionalShutdown) {
      app.log.error('RabbitMQ connection closed unexpectedly');
    }
  });
  connection.on('error', (error) => {
    publisher.markUnavailable('RabbitMQ connection error during publication.', error);
    app.log.error({ errorType: error.name }, 'RabbitMQ connection error');
  });

  const shutdown = createIdempotentShutdown(async (reason) => {
    intentionalShutdown = true;
    app.log.info({ signal: reason }, 'Shutting down producer');
    publisher.markUnavailable();
    const deadline = createDeadline(config.shutdownTimeoutMs);

    try {
      const serverClosed = await deadline.run(async () => {
        await app.close();
      });
      if (!serverClosed) {
        app.log.error(
          { operation: 'server.close', timeoutMs: config.shutdownTimeoutMs },
          'Producer server close exceeded the shutdown deadline',
        );
      }
    } catch (error) {
      app.log.error(
        {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        },
        'Producer server close failed during shutdown',
      );
    }

    if (channelOpen) {
      channelOpen = false;
      try {
        const closed = await deadline.run(async () => {
          await channel.close();
        });
        if (!closed) {
          app.log.error(
            {
              operation: 'channel.close',
              timeoutMs: config.shutdownTimeoutMs,
            },
            'RabbitMQ channel close exceeded the shutdown deadline',
          );
        }
      } catch (error) {
        app.log.error(
          {
            errorType: error instanceof Error ? error.name : 'UnknownError',
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
          app.log.error(
            {
              operation: 'connection.close',
              timeoutMs: config.shutdownTimeoutMs,
            },
            'RabbitMQ connection close exceeded the shutdown deadline',
          );
        }
      } catch (error) {
        app.log.error(
          {
            errorType: error instanceof Error ? error.name : 'UnknownError',
          },
          'RabbitMQ connection close failed during shutdown',
        );
      }
    }
  });
  const requestShutdown = (reason: string): void => {
    void shutdown(reason).catch((error: unknown) => {
      app.log.error(
        {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        },
        'Producer shutdown failed',
      );
      process.exitCode = 1;
    });
  };

  process.once('SIGINT', () => {
    requestShutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    requestShutdown('SIGTERM');
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
