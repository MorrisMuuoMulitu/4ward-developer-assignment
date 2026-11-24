import type { CityGroupJoinedEvent } from '../../../shared/src/contracts.js';
import { errorForHttpStatus, RetryableError } from '../../../shared/src/errors.js';
import { transformForSupabase } from './transform.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface SupabaseHandlerConfig {
  readonly fetch?: FetchLike;
  readonly secretKey: string;
  readonly url: string;
}

/**
 * The database's unique event_id constraint combines with merge-duplicates upserts to
 * make repeated delivery idempotent.
 */
export function createSupabaseHandler(
  config: SupabaseHandlerConfig,
): (event: CityGroupJoinedEvent) => Promise<void> {
  const fetchImplementation = config.fetch ?? fetch;
  const url = `${config.url.replace(/\/+$/, '')}/rest/v1/city_group_members?on_conflict=event_id`;

  return async (event) => {
    let response: Response;

    try {
      response = await fetchImplementation(url, {
        body: JSON.stringify(transformForSupabase(event)),
        headers: {
          apikey: config.secretKey,
          Authorization: `Bearer ${config.secretKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        method: 'POST',
      });
    } catch (error) {
      throw new RetryableError('Supabase request failed at the network layer.', {
        cause: error,
      });
    }

    if (response.ok) {
      return;
    }

    throw errorForHttpStatus('Supabase', response.status);
  };
}
