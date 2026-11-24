import { describe, expect, it } from 'vitest';

import type { CityGroupJoinedEvent } from '../../../shared/src/contracts.js';
import { RetryableError } from '../../../shared/src/errors.js';
import { createSupabaseHandler } from '../src/client.js';
import { transformForSupabase } from '../src/transform.js';

const event: CityGroupJoinedEvent = {
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
};

interface RecordedRequest {
  readonly body: string | undefined;
  readonly headers: RequestInit['headers'];
  readonly method: string;
  readonly url: string;
}

function createSupabaseFetch(response: Response, requests: RecordedRequest[]) {
  return (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: init?.headers,
      method: init?.method ?? 'GET',
      url,
    });
    return Promise.resolve(response);
  };
}

describe('Supabase transformation', () => {
  it('maps the event to the snake_case table contract', () => {
    expect(transformForSupabase(event)).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
      city: 'London',
      country: 'United Kingdom',
      interests: ['Technology', 'Climate'],
      event_id: event.eventId,
    });
  });
});

describe('Supabase consumer', () => {
  it('upserts on event_id with merge-duplicates behavior', async () => {
    const requests: RecordedRequest[] = [];
    const fetch = createSupabaseFetch(new Response(null, { status: 201 }), requests);
    const handler = createSupabaseHandler({
      fetch,
      secretKey: 'supabase-test-key',
      url: 'https://example.supabase.co/',
    });

    await handler(event);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://example.supabase.co/rest/v1/city_group_members?on_conflict=event_id',
    );
    expect(requests[0]?.method).toBe('POST');
    expect(new Headers(requests[0]?.headers).get('prefer')).toBe(
      'resolution=merge-duplicates,return=minimal',
    );
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
      city: 'London',
      country: 'United Kingdom',
      interests: ['Technology', 'Climate'],
      event_id: event.eventId,
    });
  });

  it('classifies server failures as retryable', async () => {
    const fetch = createSupabaseFetch(new Response('', { status: 500 }), []);
    const handler = createSupabaseHandler({
      fetch,
      secretKey: 'supabase-test-key',
      url: 'https://example.supabase.co',
    });

    await expect(handler(event)).rejects.toBeInstanceOf(RetryableError);
  });
});
