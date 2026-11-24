import { RetryableError } from './errors.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS = 15_000;

function isTimeoutOrAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Adds a hard deadline to an external request and converts network failures to retryable errors.
 */
export async function fetchWithTimeout(
  fetchImplementation: FetchLike,
  url: string,
  init: RequestInit,
  service: string,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchImplementation(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = isTimeoutOrAbort(error)
      ? `${service} request timed out.`
      : `${service} request failed at the network layer.`;
    throw new RetryableError(message, { cause: error });
  }
}
