import type { CityGroupJoinedEvent } from '../../../shared/src/contracts.js';
import { errorForHttpStatus } from '../../../shared/src/errors.js';
import {
  DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  type FetchLike,
} from '../../../shared/src/http.js';
import { transformForBrevo } from './transform.js';

export type { FetchLike } from '../../../shared/src/http.js';

interface BrevoHandlerConfig {
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * Brevo keys contacts by email. `updateEnabled` makes repeated deliveries an upsert.
 */
export function createBrevoHandler(
  config: BrevoHandlerConfig,
): (event: CityGroupJoinedEvent) => Promise<void> {
  const fetchImplementation = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS;

  return async (event) => {
    const response = await fetchWithTimeout(
      fetchImplementation,
      'https://api.brevo.com/v3/contacts',
      {
        body: JSON.stringify(transformForBrevo(event)),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'api-key': config.apiKey,
        },
        method: 'POST',
      },
      'Brevo',
      timeoutMs,
    );

    if (response.status === 201 || response.status === 204) {
      return;
    }

    throw errorForHttpStatus('Brevo', response.status);
  };
}
