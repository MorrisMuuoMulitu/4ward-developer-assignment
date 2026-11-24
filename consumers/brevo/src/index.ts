import { runConsumerProcess } from '../../../shared/src/consumer-process.js';
import { parseRuntimeConfig, requireExternalValue } from '../../../shared/src/config.js';
import { logStartupFailure } from '../../../shared/src/logger.js';
import { createBrevoHandler } from './client.js';

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const handler = createBrevoHandler({
    apiKey: requireExternalValue(config.external.brevoApiKey, 'BREVO_API_KEY'),
  });

  await runConsumerProcess({ destination: 'brevo', handler });
}

main().catch((error: unknown) => {
  logStartupFailure('brevo-consumer', error);
  process.exitCode = 1;
});
