import { describe, expect, it } from 'vitest';

import type { CityGroupJoinedEvent } from '../../../shared/src/contracts.js';
import { RetryableError, TerminalError } from '../../../shared/src/errors.js';
import { createBrevoHandler } from '../src/client.js';
import { transformForBrevo } from '../src/transform.js';

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

function createBrevoFetch(response: Response, requests: RecordedRequest[]) {
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

describe('Brevo transformation', () => {
  it('maps only the required contact attributes', () => {
    expect(transformForBrevo(event)).toEqual({
      email: 'jane@example.com',
      attributes: {
        NAME: 'Jane Doe',
        CITY: 'London',
        COUNTRY: 'United Kingdom',
      },
      updateEnabled: true,
    });
  });
});

describe('Brevo consumer', () => {
  it('accepts a 201 contact creation response', async () => {
    const requests: RecordedRequest[] = [];
    const fetch = createBrevoFetch(
      new Response(JSON.stringify({ id: 42 }), { status: 201 }),
      requests,
    );
    const handler = createBrevoHandler({ apiKey: 'brevo-test-key', fetch });

    await handler(event);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.brevo.com/v3/contacts');
    expect(requests[0]?.method).toBe('POST');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      email: 'jane@example.com',
      attributes: {
        NAME: 'Jane Doe',
        CITY: 'London',
        COUNTRY: 'United Kingdom',
      },
      updateEnabled: true,
    });
  });

  it('accepts a 204 contact update response without parsing a body', async () => {
    const requests: RecordedRequest[] = [];
    const fetch = createBrevoFetch(new Response(null, { status: 204 }), requests);
    const handler = createBrevoHandler({ apiKey: 'brevo-test-key', fetch });

    await expect(handler(event)).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('classifies server failures as retryable', async () => {
    const fetch = createBrevoFetch(new Response('', { status: 503 }), []);
    const handler = createBrevoHandler({ apiKey: 'brevo-test-key', fetch });

    await expect(handler(event)).rejects.toBeInstanceOf(RetryableError);
  });

  it('classifies bad requests as terminal', async () => {
    const fetch = createBrevoFetch(new Response('', { status: 400 }), []);
    const handler = createBrevoHandler({ apiKey: 'brevo-test-key', fetch });

    await expect(handler(event)).rejects.toBeInstanceOf(TerminalError);
  });
});
