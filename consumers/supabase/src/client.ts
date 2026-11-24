import type { CityGroupJoinedEvent } from '../../../shared/src/contracts.js';
import { errorForHttpStatus } from '../../../shared/src/errors.js';
import {
  DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  type FetchLike,
} from '../../../shared/src/http.js';
import { transformForSupabase } from './transform.js';

export type { FetchLike } from '../../../shared/src/http.js';

interface SupabaseHandlerConfig {
  readonly fetch?: FetchLike;
  readonly secretKey: string;
  readonly timeoutMs?: number;
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
  const timeoutMs = config.timeoutMs ?? DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS;
  const url = `${config.url.replace(/\/+$/, '')}/rest/v1/city_group_members?on_conflict=event_id`;

  return async (event) => {
    const response = await fetchWithTimeout(
      fetchImplementation,
      url,
      {
        body: JSON.stringify(transformForSupabase(event)),
        headers: {
          apikey: config.secretKey,
          Authorization: `Bearer ${config.secretKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        method: 'POST',
      },
      'Supabase',
      timeoutMs,
    );

    if (response.ok) {
      return;
    }

    throw errorForHttpStatus('Supabase', response.status);
  };
}
