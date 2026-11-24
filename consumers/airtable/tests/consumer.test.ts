import { describe, expect, it } from 'vitest';

import type { CityGroupJoinedEvent } from '../../../shared/src/contracts.js';
import { RetryableError, TerminalError } from '../../../shared/src/errors.js';
import { createAirtableHandler, escapeAirtableFormulaValue } from '../src/client.js';
import { transformForAirtable } from '../src/transform.js';

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
  readonly method: string;
  readonly signal: RequestInit['signal'];
  readonly url: string;
}

function createAirtableFetch(responses: readonly Response[], requests: RecordedRequest[]) {
  return (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({
      body: typeof init?.body === 'string' ? init.body : undefined,
      method: init?.method ?? 'GET',
      signal: init?.signal,
      url,
    });
    const response = responses[requests.length - 1];

    if (response === undefined) {
      throw new Error('Unexpected Airtable request');
    }

    return Promise.resolve(response);
  };
}

const config = {
  apiKey: 'airtable-test-token',
  baseId: 'appTest123',
  tableName: 'City Group Members',
};

describe('Airtable transformation', () => {
  it('maps the canonical event to the exact table fields', () => {
    expect(transformForAirtable(event)).toEqual({
      Name: 'Jane Doe',
      Email: 'jane@example.com',
      City: 'London',
      Country: 'United Kingdom',
      Interests: 'Technology, Climate',
      'Event ID': event.eventId,
    });
  });

  it('escapes formula string delimiters', () => {
    expect(escapeAirtableFormulaValue("O'Reilly\\Studio")).toBe("O\\'Reilly\\\\Studio");
  });
});

describe('Airtable consumer', () => {
  it('creates a record when the event has not been seen', async () => {
    const requests: RecordedRequest[] = [];
    const fetch = createAirtableFetch(
      [
        new Response(JSON.stringify({ records: [] }), { status: 200 }),
        new Response(JSON.stringify({ records: [{ id: 'rec123' }] }), { status: 200 }),
      ],
      requests,
    );
    const handler = createAirtableHandler({ ...config, fetch });

    await handler(event);

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.signal instanceof AbortSignal)).toBe(true);
    const lookupUrl = new URL(requests[0]?.url ?? '');
    expect(lookupUrl.searchParams.get('filterByFormula')).toBe(
      "{Event ID}='7eec8d9b-ee33-4bdf-a63c-0bd9377fbde6'",
    );
    expect(requests[1]?.method).toBe('POST');
    expect(JSON.parse(requests[1]?.body ?? '{}')).toEqual({
      fields: {
        Name: 'Jane Doe',
        Email: 'jane@example.com',
        City: 'London',
        Country: 'United Kingdom',
        Interests: 'Technology, Climate',
        'Event ID': event.eventId,
      },
      typecast: false,
    });
  });

  it('does not create a duplicate record when the event ID already exists', async () => {
    const requests: RecordedRequest[] = [];
    const fetch = createAirtableFetch(
      [
        new Response(JSON.stringify({ records: [{ id: 'rec123' }] }), {
          status: 200,
        }),
      ],
      requests,
    );
    const handler = createAirtableHandler({ ...config, fetch });

    await handler(event);

    expect(requests).toHaveLength(1);
  });

  it('classifies API throttling as retryable', async () => {
    const fetch = createAirtableFetch([new Response('', { status: 429 })], []);
    const handler = createAirtableHandler({ ...config, fetch });

    await expect(handler(event)).rejects.toBeInstanceOf(RetryableError);
  });

  it('classifies authorization failures as terminal', async () => {
    const fetch = createAirtableFetch([new Response('', { status: 401 })], []);
    const handler = createAirtableHandler({ ...config, fetch });

    await expect(handler(event)).rejects.toBeInstanceOf(TerminalError);
  });

  it('applies a timeout signal and classifies TimeoutError as retryable', async () => {
    const requests: RecordedRequest[] = [];
    const timeoutError = new Error('request timed out');
    timeoutError.name = 'TimeoutError';
    const fetch = (url: string, init?: RequestInit): Promise<Response> => {
      requests.push({
        body: typeof init?.body === 'string' ? init.body : undefined,
        method: init?.method ?? 'GET',
        signal: init?.signal,
        url,
      });
      return Promise.reject(timeoutError);
    };
    const handler = createAirtableHandler({ ...config, fetch, timeoutMs: 250 });

    await expect(handler(event)).rejects.toMatchObject({
      message: 'Airtable request timed out.',
      name: 'RetryableError',
    });
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
