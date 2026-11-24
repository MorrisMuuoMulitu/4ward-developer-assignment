import pino from 'pino';

import type { MessageLogger } from './consumer-runtime.js';

export function createMessageLogger(level: pino.LevelWithSilent, name: string): MessageLogger {
  const logger = pino({
    base: { service: name },
    level,
    redact: {
      censor: '[REDACTED]',
      paths: [
        'apiKey',
        'authorization',
        'token',
        '*.apiKey',
        '*.authorization',
        '*.serviceRoleKey',
        '*.token',
      ],
    },
  });

  return {
    error: (context, message) => {
      logger.error(context, message);
    },
    info: (context, message) => {
      logger.info(context, message);
    },
  };
}

export function logStartupFailure(service: string, error: unknown): void {
  pino({
    base: { service },
    level: 'error',
    redact: {
      censor: '[REDACTED]',
      paths: [
        'err.apiKey',
        'err.authorization',
        'err.token',
        'err.cause.apiKey',
        'err.cause.authorization',
        'err.cause.token',
      ],
    },
  }).error({ err: error }, 'Service failed to start');
}
