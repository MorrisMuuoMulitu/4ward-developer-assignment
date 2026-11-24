import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createProducerApp } from '../src/app.js';
import type { EventPublisher } from '../../shared/src/publisher.js';
import { RetryableError } from '../../shared/src/errors.js';
import type { CityGroupJoinedEvent } from '../../shared/src/contracts.js';

class RecordingPublisher implements EventPublisher {
  public readonly published: CityGroupJoinedEvent[] = [];
  public ready = true;

  public isReady(): boolean {
    return this.ready;
  }

  public publish(event: CityGroupJoinedEvent): Promise<void> {
    this.published.push(event);
    return Promise.resolve();
  }
}

const eventId = '7eec8d9b-ee33-4bdf-a63c-0bd9377fbde6';
const now = new Date('2026-11-16T10:30:00.000Z');

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

describe('producer routes', () => {
  it('serves an accessible join form', async () => {
    app = await createProducerApp({
      idGenerator: () => eventId,
      logger: false,
      now: () => now,
      publisher: new RecordingPublisher(),
    });

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<form');
    expect(response.body).toContain('name="email"');
    expect(response.body).toContain('name="interests"');
  });

  it('reports readiness from the RabbitMQ publisher', async () => {
    const publisher = new RecordingPublisher();
    app = await createProducerApp({
      idGenerator: () => eventId,
      logger: false,
      now: () => now,
      publisher,
    });

    const ready = await app.inject({ method: 'GET', url: '/health' });
    publisher.ready = false;
    const unavailable = await app.inject({ method: 'GET', url: '/health' });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok', rabbitmq: 'ready' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ status: 'error', rabbitmq: 'unavailable' });
  });

  it('validates, builds, and publishes a JSON submission', async () => {
    const publisher = new RecordingPublisher();
    app = await createProducerApp({
      idGenerator: () => eventId,
      logger: false,
      now: () => now,
      publisher,
    });

    const response = await app.inject({
      method: 'POST',
      payload: {
        name: 'Jane Doe',
        email: 'jane@example.com',
        city: 'London',
        country: 'United Kingdom',
        interests: ['Technology', 'Climate'],
      },
      url: '/api/join',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'accepted', eventId });
    expect(publisher.published).toEqual([
      {
        event: 'CityGroupJoined',
        eventId,
        timestamp: '2026-11-16T10:30:00.000Z',
        data: {
          name: 'Jane Doe',
          email: 'jane@example.com',
          city: 'London',
          country: 'United Kingdom',
          interests: ['Technology', 'Climate'],
        },
      },
    ]);
  });

  it('accepts URL-encoded form submissions', async () => {
    const publisher = new RecordingPublisher();
    app = await createProducerApp({
      idGenerator: () => eventId,
      logger: false,
      now: () => now,
      publisher,
    });

    const response = await app.inject({
      body: new URLSearchParams({
        name: 'Jane Doe',
        email: 'jane@example.com',
        city: 'London',
        country: 'United Kingdom',
        interests: 'Technology, Climate',
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      url: '/api/join',
    });

    expect(response.statusCode).toBe(202);
    expect(publisher.published[0]?.data.interests).toEqual(['Technology', 'Climate']);
  });

  it('returns structured validation details without publishing', async () => {
    const publisher = new RecordingPublisher();
    app = await createProducerApp({
      idGenerator: () => eventId,
      logger: false,
      now: () => now,
      publisher,
    });

    const response = await app.inject({
      method: 'POST',
      payload: {
        name: '',
        email: 'invalid',
        city: 'London',
        country: 'United Kingdom',
      },
      url: '/api/join',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The join request is invalid.',
      },
    });
    expect(publisher.published).toEqual([]);
  });

  it('returns 503 without claiming acceptance when publishing fails', async () => {
    app = await createProducerApp({
      idGenerator: () => eventId,
      logger: false,
      now: () => now,
      publisher: {
        isReady: () => true,
        publish: () => Promise.reject(new RetryableError('Broker unavailable')),
      },
    });

    const response = await app.inject({
      method: 'POST',
      payload: {
        name: 'Jane Doe',
        email: 'jane@example.com',
        city: 'London',
        country: 'United Kingdom',
      },
      url: '/api/join',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: 'PUBLISH_FAILED',
        message: 'The join request could not be queued.',
      },
    });
  });
});
