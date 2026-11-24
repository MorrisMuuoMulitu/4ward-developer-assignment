import { describe, expect, it } from 'vitest';

import { errorForHttpStatus } from '../src/errors.js';

describe('HTTP error classification', () => {
  it.each([408, 429, 500, 503])('classifies HTTP %i as retryable', (status) => {
    expect(errorForHttpStatus('Provider', status)).toMatchObject({
      name: 'RetryableError',
    });
  });

  it.each([400, 401, 403, 404, 409])('classifies HTTP %i as terminal', (status) => {
    expect(errorForHttpStatus('Provider', status)).toMatchObject({
      name: 'TerminalError',
    });
  });
});
