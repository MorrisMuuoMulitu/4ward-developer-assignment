import { runConsumerProcess } from '../../../shared/src/consumer-process.js';
import { parseRuntimeConfig, requireExternalValue } from '../../../shared/src/config.js';
import { logStartupFailure } from '../../../shared/src/logger.js';
import { createAirtableHandler } from './client.js';

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const handler = createAirtableHandler({
    apiKey: requireExternalValue(config.external.airtableApiKey, 'AIRTABLE_API_KEY'),
    baseId: requireExternalValue(config.external.airtableBaseId, 'AIRTABLE_BASE_ID'),
    tableName: config.external.airtableTableName,
  });

  await runConsumerProcess({ destination: 'airtable', handler });
}

main().catch((error: unknown) => {
  logStartupFailure('airtable-consumer', error);
  process.exitCode = 1;
});
