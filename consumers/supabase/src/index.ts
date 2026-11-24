import { runConsumerProcess } from '../../../shared/src/consumer-process.js';
import { parseRuntimeConfig, requireExternalValue } from '../../../shared/src/config.js';
import { logStartupFailure } from '../../../shared/src/logger.js';
import { createSupabaseHandler } from './client.js';

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const handler = createSupabaseHandler({
    secretKey: requireExternalValue(
      config.external.supabaseSecretKey ?? config.external.supabaseServiceRoleKey,
      'SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY',
    ),
    timeoutMs: config.external.requestTimeoutMs,
    url: requireExternalValue(config.external.supabaseUrl, 'SUPABASE_URL'),
  });

  await runConsumerProcess({ destination: 'supabase', handler });
}

main().catch((error: unknown) => {
  logStartupFailure('supabase-consumer', error);
  process.exitCode = 1;
});
