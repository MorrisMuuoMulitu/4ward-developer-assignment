import { describe, expect, it } from 'vitest';

import {
  createCityGroupJoinedEvent,
  joinSubmissionSchema,
  parseCityGroupJoinedEvent,
} from '../src/contracts.js';
import { parseRuntimeConfig } from '../src/config.js';

describe('join submission validation', () => {
  it('normalizes JSON interests and email whitespace', () => {
    const result = joinSubmissionSchema.parse({
      name: '  Jane Doe ',
      email: ' JANE@EXAMPLE.COM ',
      city: ' London ',
      country: ' United Kingdom ',
      interests: [' Technology ', '', 'Climate', 'Technology'],
    });

    expect(result).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
      city: 'London',
      country: 'United Kingdom',
      interests: ['Technology', 'Climate'],
    });
  });

  it('normalizes comma-separated form interests', () => {
    const result = joinSubmissionSchema.parse({
      name: 'Jane Doe',
      email: 'jane@example.com',
      city: 'London',
      country: 'United Kingdom',
      interests: 'Technology, Climate, ,Technology',
    });

    expect(result.interests).toEqual(['Technology', 'Climate']);
  });

  it('normalizes a single form interest', () => {
    const result = joinSubmissionSchema.parse({
      name: 'Jane Doe',
      email: 'jane@example.com',
      city: 'London',
      country: 'United Kingdom',
      interests: 'Climate',
    });

    expect(result.interests).toEqual(['Climate']);
  });

  it('uses an empty interests array when the field is omitted', () => {
    const result = joinSubmissionSchema.parse({
      name: 'Jane Doe',
      email: 'jane@example.com',
      city: 'London',
      country: 'United Kingdom',
    });

    expect(result.interests).toEqual([]);
  });

  it('rejects malformed input and unknown fields', () => {
    const result = joinSubmissionSchema.safeParse({
      name: 'Jane Doe',
      email: 'not-an-email',
      city: '',
      country: 'United Kingdom',
      unexpected: true,
    });

    expect(result.success).toBe(false);
  });
});

describe('CityGroupJoined event contract', () => {
  it('constructs the canonical event with deterministic metadata', () => {
    const event = createCityGroupJoinedEvent(
      {
        name: 'Jane Doe',
        email: 'jane@example.com',
        city: 'London',
        country: 'United Kingdom',
        interests: ['Technology', 'Climate'],
      },
      {
        eventId: '7eec8d9b-ee33-4bdf-a63c-0bd9377fbde6',
        now: new Date('2026-11-16T10:30:00.000Z'),
      },
    );

    expect(event).toEqual({
      event: 'CityGroupJoined',
      eventId: '7eec8d9b-ee33-4bdf-a63c-0bd9377fbde6',
      timestamp: '2026-11-16T10:30:00.000Z',
      data: {
        name: 'Jane Doe',
        email: 'jane@example.com',
        city: 'London',
        country: 'United Kingdom',
        interests: ['Technology', 'Climate'],
      },
    });
  });

  it('rejects malformed serialized events before consumer processing', () => {
    expect(() =>
      parseCityGroupJoinedEvent({
        event: 'DifferentEvent',
        eventId: 'not-a-uuid',
        timestamp: 'yesterday',
        data: {},
      }),
    ).toThrow();
  });
});

describe('runtime configuration', () => {
  it('applies safe defaults and parses numeric settings', () => {
    const config = parseRuntimeConfig({
      NODE_ENV: 'test',
      RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
      MAX_RETRY_ATTEMPTS: '4',
      RETRY_INITIAL_DELAY_MS: '500',
      RETRY_MAX_DELAY_MS: '5000',
      CONSUMER_PREFETCH: '3',
      EXTERNAL_REQUEST_TIMEOUT_MS: '9000',
      SHUTDOWN_TIMEOUT_MS: '8000',
    });

    expect(config.retry).toEqual({
      maxAttempts: 4,
      initialDelayMs: 500,
      maxDelayMs: 5000,
    });
    expect(config.rabbitmq.exchange).toBe('city-group.events');
    expect(config.consumerPrefetch).toBe(3);
    expect(config.external.requestTimeoutMs).toBe(9000);
    expect(config.shutdownTimeoutMs).toBe(8000);
  });

  it('accepts a Supabase secret key for server-side integration', () => {
    const config = parseRuntimeConfig({
      SUPABASE_SECRET_KEY: 'sb_secret_test',
      SUPABASE_URL: 'https://example.supabase.co',
    });

    expect(config.external.supabaseSecretKey).toBe('sb_secret_test');
    expect(config.external.supabaseServiceRoleKey).toBeUndefined();
  });

  it('applies network and shutdown timeout defaults', () => {
    const config = parseRuntimeConfig({});

    expect(config.external.requestTimeoutMs).toBe(15_000);
    expect(config.shutdownTimeoutMs).toBe(10_000);
  });

  it.each([
    { EXTERNAL_REQUEST_TIMEOUT_MS: '0' },
    { EXTERNAL_REQUEST_TIMEOUT_MS: '120001' },
    { SHUTDOWN_TIMEOUT_MS: '0' },
    { SHUTDOWN_TIMEOUT_MS: '60001' },
  ])('rejects invalid timeout configuration %o', (environment) => {
    expect(() => parseRuntimeConfig(environment)).toThrow('Environment configuration is invalid.');
  });
});
