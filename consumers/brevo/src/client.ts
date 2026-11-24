import type { CityGroupJoinedEvent } from '../../../shared/src/contracts.js';
import { errorForHttpStatus, RetryableError } from '../../../shared/src/errors.js';
import { transformForBrevo } from './transform.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface BrevoHandlerConfig {
  readonly apiKey: string;
  readonly fetch?: FetchLike;
}

/**
 * Brevo keys contacts by email. `updateEnabled` makes repeated deliveries an upsert.
 */
export function createBrevoHandler(
  config: BrevoHandlerConfig,
): (event: CityGroupJoinedEvent) => Promise<void> {
  const fetchImplementation = config.fetch ?? fetch;

  return async (event) => {
    let response: Response;

    try {
      response = await fetchImplementation('https://api.brevo.com/v3/contacts', {
        body: JSON.stringify(transformForBrevo(event)),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'api-key': config.apiKey,
        },
        method: 'POST',
      });
    } catch (error) {
      throw new RetryableError('Brevo request failed at the network layer.', {
        cause: error,
      });
    }

    if (response.status === 201 || response.status === 204) {
      return;
    }

    throw errorForHttpStatus('Brevo', response.status);
  };
}
