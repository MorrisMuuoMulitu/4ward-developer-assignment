import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { connect, type ConfirmChannel } from 'amqplib';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createAirtableHandler } from '../../consumers/airtable/src/client.js';
import { createBrevoHandler } from '../../consumers/brevo/src/client.js';
import { createSupabaseHandler } from '../../consumers/supabase/src/client.js';
import { createProducerApp } from '../../producer/src/app.js';
import type { CityGroupJoinedEvent } from '../../shared/src/contracts.js';
import type { MessageLogger } from '../../shared/src/consumer-runtime.js';
import { RetryableError } from '../../shared/src/errors.js';
import {
  RabbitEventPublisher,
  type ConfirmChannelLike,
} from '../../shared/src/rabbit-publisher.js';
import { declareConsumerTopology, startQueueConsumer } from '../../shared/src/rabbit-consumer.js';
import {
  topologyFor,
  type ConsumerDestination,
  type ConsumerTopology,
} from '../../shared/src/topology.js';

const rabbitUrl = process.env['RABBITMQ_URL'] ?? 'amqp://guest:guest@localhost:5672';
const silentLogger: MessageLogger = {
  error: () => undefined,
  info: () => undefined,
};

interface Signal {
  readonly promise: Promise<void>;
  resolve(): void;
}

function signal(): Signal {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return {
    promise,
    resolve: () => {
      resolve();
    },
  };
}

interface MockApiState {
  airtableCreates: string[];
  airtableLookups: number;
  brevoCreates: string[];
  failNextAirtableLookup: boolean;
  supabaseCreates: string[];
}

interface MockApi {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly state: MockApiState;
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    }
  }

  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function startMockApi(state: MockApiState): Promise<MockApi> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname.startsWith('/airtable/')) {
        state.airtableLookups += 1;

        if (state.failNextAirtableLookup) {
          state.failNextAirtableLookup = false;
          response.writeHead(500);
          response.end('temporary failure');
          return;
        }

        sendJson(response, 200, { records: [] });
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/airtable/')) {
        state.airtableCreates.push(await requestBody(request));
        sendJson(response, 200, { records: [{ id: 'rec-integration' }] });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/brevo/v3/contacts') {
        state.brevoCreates.push(await requestBody(request));
        sendJson(response, 201, { id: 42 });
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/supabase/rest/v1/')) {
        state.supabaseCreates.push(await requestBody(request));
        response.writeHead(201);
        response.end();
        return;
      }

      response.writeHead(404);
      response.end();
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Mock API did not bind to a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
    state,
  };
}

function destinationFetch(baseUrl: string) {
  return (url: string, init?: RequestInit): Promise<Response> => {
    const original = new URL(url);
    const prefix = original.hostname === 'api.airtable.com' ? '/airtable' : '/brevo';
    const target = new URL(`${prefix}${original.pathname}`, baseUrl);
    target.search = original.search;
    return fetch(target, init);
  };
}

function confirmAdapter(channel: ConfirmChannel): ConfirmChannelLike {
  return {
    publish: (exchange, routingKey, content, options) =>
      channel.publish(exchange, routingKey, content, options),
    waitForConfirms: () => channel.waitForConfirms(),
  };
}

async function startConsumers(
  exchange: string,
  api: MockApi,
): Promise<{
  readonly channels: ConfirmChannel[];
  readonly connections: Awaited<ReturnType<typeof connect>>[];
  readonly topologies: ConsumerTopology[];
}> {
  const fetchImplementation = destinationFetch(api.baseUrl);
  const handlers: Record<ConsumerDestination, (event: CityGroupJoinedEvent) => Promise<void>> = {
    airtable: createAirtableHandler({
      apiKey: 'airtable-test-token',
      baseId: 'appIntegration',
      fetch: fetchImplementation,
      tableName: 'City Group Members',
    }),
    brevo: createBrevoHandler({
      apiKey: 'brevo-test-token',
      fetch: fetchImplementation,
    }),
    supabase: createSupabaseHandler({
      fetch,
      secretKey: 'supabase-test-token',
      url: `${api.baseUrl}/supabase`,
    }),
  };
  const destinations: ConsumerDestination[] = ['airtable', 'brevo', 'supabase'];
  const channels: ConfirmChannel[] = [];
  const connections: Awaited<ReturnType<typeof connect>>[] = [];
  const topologies: ConsumerTopology[] = [];

  for (const destination of destinations) {
    const connection = await connect(rabbitUrl);
    const channel = await connection.createConfirmChannel();
    const topology = topologyFor(exchange, destination);
    await declareConsumerTopology(channel, topology);
    await startQueueConsumer({
      channel,
      handler: handlers[destination],
      logger: silentLogger,
      maxRetryAttempts: 2,
      prefetch: 1,
      retryInitialDelayMs: 75,
      retryMaxDelayMs: 250,
      topology,
    });
    connections.push(connection);
    channels.push(channel);
    topologies.push(topology);
  }

  return { channels, connections, topologies };
}

async function waitForCount(
  channel: ConfirmChannel,
  queue: string,
  expectedCount: number,
): Promise<void> {
  await waitForCondition(
    async () => {
      const state = await channel.checkQueue(queue);
      return state.messageCount === expectedCount;
    },
    `Timed out waiting for ${queue} to reach ${String(expectedCount)} messages.`,
  );
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  failureMessage: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(failureMessage);
}

async function deleteTopologies(
  channel: ConfirmChannel,
  topologies: readonly ConsumerTopology[],
): Promise<void> {
  for (const topology of topologies) {
    await channel.deleteQueue(topology.queues.deadLetter);
    await channel.deleteQueue(topology.queues.retry);
    await channel.deleteQueue(topology.queues.main);
    await channel.deleteExchange(topology.exchange);
  }
}

async function submit(baseUrl: string, email: string): Promise<Response> {
  return fetch(`${baseUrl}/api/join`, {
    body: JSON.stringify({
      city: 'Nairobi',
      country: 'Kenya',
      email,
      interests: ['Technology', 'Climate'],
      name: 'Integration User',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup !== undefined) {
    await cleanup();
    cleanup = undefined;
  }
});

describe('live RabbitMQ event flow', () => {
  it('delivers one event to all consumers and retries one isolated failure', async () => {
    const exchange = `city-group.events.integration.${randomUUID()}`;
    const api = await startMockApi({
      airtableCreates: [],
      airtableLookups: 0,
      brevoCreates: [],
      failNextAirtableLookup: false,
      supabaseCreates: [],
    });
    const connection = await connect(rabbitUrl);
    const producerChannel = await connection.createConfirmChannel();
    const consumers = await startConsumers(exchange, api);
    const publisher = new RabbitEventPublisher(confirmAdapter(producerChannel), exchange);
    const app: FastifyInstance = await createProducerApp({ logger: false, publisher });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    cleanup = async () => {
      await app.close();
      await Promise.all(consumers.channels.map((channel) => channel.close()));
      await Promise.all(
        consumers.connections.map((consumerConnection) => consumerConnection.close()),
      );
      await deleteTopologies(producerChannel, consumers.topologies);
      await producerChannel.close();
      await connection.close();
      await api.close();
    };

    const firstResponse = await submit(address, 'first@example.com');
    expect(firstResponse.status).toBe(202);
    await waitForCondition(
      () =>
        api.state.airtableCreates.length === 1 &&
        api.state.brevoCreates.length === 1 &&
        api.state.supabaseCreates.length === 1,
      'Timed out waiting for all destination consumers to process the first event.',
    );
    await waitForCount(producerChannel, consumers.topologies[0]?.queues.main ?? '', 0);
    await waitForCount(producerChannel, consumers.topologies[1]?.queues.main ?? '', 0);
    await waitForCount(producerChannel, consumers.topologies[2]?.queues.main ?? '', 0);

    expect(api.state.airtableCreates).toHaveLength(1);
    expect(api.state.brevoCreates).toHaveLength(1);
    expect(api.state.supabaseCreates).toHaveLength(1);

    api.state.failNextAirtableLookup = true;
    const secondResponse = await submit(address, 'second@example.com');
    expect(secondResponse.status).toBe(202);
    await waitForCondition(
      () =>
        api.state.airtableCreates.length === 2 &&
        api.state.brevoCreates.length === 2 &&
        api.state.supabaseCreates.length === 2,
      'Timed out waiting for the retry and isolated consumers to finish.',
    );
    await waitForCount(producerChannel, consumers.topologies[1]?.queues.main ?? '', 0);
    await waitForCount(producerChannel, consumers.topologies[2]?.queues.main ?? '', 0);
    await waitForCount(producerChannel, consumers.topologies[0]?.queues.main ?? '', 0);

    expect(api.state.airtableLookups).toBe(3);
    expect(api.state.airtableCreates).toHaveLength(2);
    expect(api.state.brevoCreates).toHaveLength(2);
    expect(api.state.supabaseCreates).toHaveLength(2);
    expect(JSON.parse(api.state.brevoCreates[1] ?? '{}')).toMatchObject({
      email: 'second@example.com',
      updateEnabled: true,
    });
  });

  it('moves an exhausted retryable failure into the destination DLQ', async () => {
    const exchange = `city-group.events.dlq.${randomUUID()}`;
    const connection = await connect(rabbitUrl);
    const producerChannel = await connection.createConfirmChannel();
    const consumerConnection = await connect(rabbitUrl);
    const consumerChannel = await consumerConnection.createConfirmChannel();
    const topology = topologyFor(exchange, 'airtable');

    cleanup = async () => {
      await consumerChannel.close();
      await deleteTopologies(producerChannel, [topology]);
      await producerChannel.close();
      await consumerConnection.close();
      await connection.close();
    };

    await declareConsumerTopology(producerChannel, topology);
    await startQueueConsumer({
      channel: consumerChannel,
      handler: () => Promise.reject(new RetryableError('Destination remains unavailable')),
      logger: silentLogger,
      maxRetryAttempts: 0,
      prefetch: 1,
      retryInitialDelayMs: 50,
      retryMaxDelayMs: 50,
      topology,
    });

    const publisher = new RabbitEventPublisher(confirmAdapter(producerChannel), exchange);
    await publisher.publish({
      event: 'CityGroupJoined',
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        name: 'Dead Letter User',
        email: 'dead-letter@example.com',
        city: 'Nairobi',
        country: 'Kenya',
        interests: [],
      },
    });

    await waitForCount(producerChannel, topology.queues.deadLetter, 1);
    const deadLetter = await producerChannel.get(topology.queues.deadLetter, {
      noAck: false,
    });

    expect(deadLetter).not.toBe(false);
    if (deadLetter === false) {
      throw new Error('Dead-letter queue did not return the exhausted message.');
    }

    expect(deadLetter.properties.headers).toMatchObject({
      'x-error-type': 'RetryableError',
      'x-retry-count': 0,
    });
    producerChannel.ack(deadLetter);
  });

  it('drains an in-flight delivery before a consumer subscription stops', async () => {
    const exchange = `city-group.events.shutdown.${randomUUID()}`;
    const connection = await connect(rabbitUrl);
    const producerChannel = await connection.createConfirmChannel();
    const consumerConnection = await connect(rabbitUrl);
    const consumerChannel = await consumerConnection.createConfirmChannel();
    const topology = topologyFor(exchange, 'brevo');
    const started = signal();
    const finish = signal();

    cleanup = async () => {
      await consumerChannel.close();
      await deleteTopologies(producerChannel, [topology]);
      await producerChannel.close();
      await consumerConnection.close();
      await connection.close();
    };

    await declareConsumerTopology(producerChannel, topology);
    const subscription = await startQueueConsumer({
      channel: consumerChannel,
      handler: async () => {
        started.resolve();
        await finish.promise;
      },
      logger: silentLogger,
      maxRetryAttempts: 2,
      prefetch: 1,
      retryInitialDelayMs: 50,
      retryMaxDelayMs: 50,
      topology,
    });

    const publisher = new RabbitEventPublisher(confirmAdapter(producerChannel), exchange);
    await publisher.publish({
      event: 'CityGroupJoined',
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        name: 'Shutdown User',
        email: 'shutdown@example.com',
        city: 'Nairobi',
        country: 'Kenya',
        interests: [],
      },
    });
    await started.promise;

    let stopped = false;
    const stopping = subscription.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finish.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect((await producerChannel.checkQueue(topology.queues.main)).messageCount).toBe(0);
  });
});
