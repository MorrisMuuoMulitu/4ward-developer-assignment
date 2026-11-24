/**
 * A failure that may succeed if the operation is attempted again.
 */
export class RetryableError extends Error {
  public override readonly name: string = 'RetryableError';

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * A failure that requires configuration or payload changes before retrying.
 */
export class TerminalError extends Error {
  public override readonly name: string = 'TerminalError';

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Invalid local configuration should fail fast instead of entering a retry loop.
 */
export class ConfigurationError extends TerminalError {
  public override readonly name: string = 'ConfigurationError';
}

/**
 * A malformed retry header cannot be interpreted safely and must not restart the retry budget.
 */
export class InvalidRetryMetadataError extends TerminalError {
  public override readonly name: string = 'InvalidRetryMetadataError';
}

/**
 * Classifies an external HTTP response using the service's retry contract.
 */
export function errorForHttpStatus(service: string, status: number): Error {
  if (status === 408 || status === 429 || status >= 500) {
    return new RetryableError(`${service} returned retryable HTTP status ${String(status)}.`);
  }

  return new TerminalError(`${service} returned terminal HTTP status ${String(status)}.`);
}

export function isRetryableError(error: unknown): boolean {
  return error instanceof RetryableError;
}
