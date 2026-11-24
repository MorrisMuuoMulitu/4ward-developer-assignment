import { z } from 'zod';

import type { CityGroupJoinedEvent } from '../../../shared/src/contracts.js';
import { errorForHttpStatus, RetryableError, TerminalError } from '../../../shared/src/errors.js';
import { transformForAirtable } from './transform.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface AirtableHandlerConfig {
  readonly apiKey: string;
  readonly baseId: string;
  readonly fetch?: FetchLike;
  readonly tableName: string;
}

const listResponseSchema = z.object({
  records: z.array(z.unknown()),
});

export function escapeAirtableFormulaValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function endpoint(config: AirtableHandlerConfig): string {
  return `https://api.airtable.com/v0/${encodeURIComponent(config.baseId)}/${encodeURIComponent(config.tableName)}`;
}

async function request(
  fetchImplementation: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImplementation(url, init);
  } catch (error) {
    throw new RetryableError('Airtable request failed at the network layer.', {
      cause: error,
    });
  }
}

/**
 * Airtable has no uniqueness constraint on regular fields. The event lookup prevents ordinary
 * duplicates but cannot eliminate a concurrent check-and-create race.
 */
export function createAirtableHandler(
  config: AirtableHandlerConfig,
): (event: CityGroupJoinedEvent) => Promise<void> {
  const fetchImplementation = config.fetch ?? fetch;
  const baseUrl = endpoint(config);
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };

  return async (event) => {
    const formula = `{Event ID}='${escapeAirtableFormulaValue(event.eventId)}'`;
    const query = new URLSearchParams({
      filterByFormula: formula,
      maxRecords: '1',
    });
    const listResponse = await request(fetchImplementation, `${baseUrl}?${query.toString()}`, {
      headers,
      method: 'GET',
    });

    if (!listResponse.ok) {
      throw errorForHttpStatus('Airtable', listResponse.status);
    }

    let listPayload: unknown;
    try {
      listPayload = await listResponse.json();
    } catch (error) {
      throw new TerminalError('Airtable returned a non-JSON lookup response.', {
        cause: error,
      });
    }

    const parsed = listResponseSchema.safeParse(listPayload);
    if (!parsed.success) {
      throw new TerminalError('Airtable returned an unexpected lookup response.');
    }

    if (parsed.data.records.length > 0) {
      return;
    }

    const createResponse = await request(fetchImplementation, baseUrl, {
      body: JSON.stringify({
        fields: transformForAirtable(event),
        typecast: false,
      }),
      headers,
      method: 'POST',
    });

    if (!createResponse.ok) {
      throw errorForHttpStatus('Airtable', createResponse.status);
    }
  };
}
