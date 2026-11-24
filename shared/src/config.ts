import { z } from 'zod';

import { ConfigurationError } from './errors.js';

const optionalStringSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RABBITMQ_URL: z.string().min(1).default('amqp://guest:guest@localhost:5672'),
  RABBITMQ_EXCHANGE: z.string().min(1).default('city-group.events'),
  CONSUMER_PREFETCH: z.coerce.number().int().min(1).max(100).default(10),
  MAX_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(20).default(3),
  RETRY_INITIAL_DELAY_MS: z.coerce.number().int().min(1).max(60_000).default(1000),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).max(300_000).default(30_000),
  AIRTABLE_API_KEY: optionalStringSchema,
  AIRTABLE_BASE_ID: optionalStringSchema,
  AIRTABLE_TABLE_NAME: z.string().min(1).default('City Group Members'),
  BREVO_API_KEY: optionalStringSchema,
  SUPABASE_URL: optionalStringSchema,
  SUPABASE_SECRET_KEY: optionalStringSchema,
  SUPABASE_SERVICE_ROLE_KEY: optionalStringSchema,
});

export interface RuntimeConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly consumerPrefetch: number;
  readonly rabbitmq: {
    readonly url: string;
    readonly exchange: string;
  };
  readonly retry: {
    readonly maxAttempts: number;
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
  };
  readonly external: {
    readonly airtableApiKey: string | undefined;
    readonly airtableBaseId: string | undefined;
    readonly airtableTableName: string;
    readonly brevoApiKey: string | undefined;
    readonly supabaseUrl: string | undefined;
    readonly supabaseSecretKey: string | undefined;
    readonly supabaseServiceRoleKey: string | undefined;
  };
}

/**
 * Parses process configuration once and converts failures into typed startup errors.
 */
export function parseRuntimeConfig(environment: Record<string, string | undefined>): RuntimeConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigurationError('Environment configuration is invalid.', {
      cause: result.error,
    });
  }

  if (result.data.RETRY_MAX_DELAY_MS < result.data.RETRY_INITIAL_DELAY_MS) {
    throw new ConfigurationError(
      'RETRY_MAX_DELAY_MS must be greater than or equal to RETRY_INITIAL_DELAY_MS.',
    );
  }

  return {
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    logLevel: result.data.LOG_LEVEL,
    consumerPrefetch: result.data.CONSUMER_PREFETCH,
    rabbitmq: {
      url: result.data.RABBITMQ_URL,
      exchange: result.data.RABBITMQ_EXCHANGE,
    },
    retry: {
      maxAttempts: result.data.MAX_RETRY_ATTEMPTS,
      initialDelayMs: result.data.RETRY_INITIAL_DELAY_MS,
      maxDelayMs: result.data.RETRY_MAX_DELAY_MS,
    },
    external: {
      airtableApiKey: result.data.AIRTABLE_API_KEY,
      airtableBaseId: result.data.AIRTABLE_BASE_ID,
      airtableTableName: result.data.AIRTABLE_TABLE_NAME,
      brevoApiKey: result.data.BREVO_API_KEY,
      supabaseUrl: result.data.SUPABASE_URL,
      supabaseSecretKey: result.data.SUPABASE_SECRET_KEY,
      supabaseServiceRoleKey: result.data.SUPABASE_SERVICE_ROLE_KEY,
    },
  };
}

export function requireExternalValue(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new ConfigurationError(`${name} is required for this service.`);
  }

  return value;
}
