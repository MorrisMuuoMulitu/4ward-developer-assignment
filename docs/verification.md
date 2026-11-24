# Verification Evidence

Add evidence of your completed implementation here.

Examples:

- Screenshots
- Relevant test output
- Manual verification notes

Document at least one successful end-to-end flow and one retry/failure scenario.

## Automated broker integration

Verified on 2026-11-24 with `pnpm test:integration` against the RabbitMQ
`4.4.1-management-alpine` container from `docker-compose.yml`.

Result:

```text
Test Files  1 passed (1)
Tests       3 passed (3)
```

The integration suite verifies:

1. A real Fastify HTTP request publishes one event through a durable topic exchange into three
   independent destination queues.
2. Mocked Airtable, Brevo, and Supabase HTTP endpoints receive the transformed records.
3. A forced HTTP `500` from Airtable is routed through its retry queue and succeeds on the next
   attempt while Brevo and Supabase process independently.
4. With `MAX_RETRY_ATTEMPTS=0`, a retryable failure reaches the destination DLQ with
   `x-error-type: RetryableError` and `x-retry-count: 0`.
5. Consumer shutdown cancels new intake and drains an in-flight delivery before closing its
   channel.

Each test uses a unique exchange and destination queues. The suite deletes those durable resources
after every scenario. A post-run RabbitMQ management API check reported `Remaining test queues: 0`
and `Remaining test exchanges: 0`.

## Live external service verification

### Happy path: verified

Verified on 2026-11-24 with the real producer, RabbitMQ, and all three consumers.

```text
GET /health  -> 200 {"status":"ok","rabbitmq":"ready"}
GET /        -> 200 text/html
POST /api/join -> 202
eventId -> 9354c080-c813-4958-9c75-1a3c4e5b05a1
```

The submitted values were Jane Doe, `jane.4ward.verify@example.com`, London, United Kingdom, and
`["Technology", "Climate"]`. All consumers acknowledged successfully.

- Airtable returned the expected record `rechM1eplVuoWoZQQ` with matching `Name`, `Email`, `City`,
  `Country`, `Interests = "Technology, Climate"`, and `Event ID`.
- Brevo returned contact `3` with matching `NAME`, `CITY`, and `COUNTRY` attributes.
- Supabase returned row `7d3ea957-035a-4733-9d44-c5493b106a21` with matching `event_id`, fields,
  generated `id` and `created_at`, and JSONB interests `["Technology","Climate"]`.

### Existing-contact update: verified

A second submission for the same email produced event `f03e520e-685f-4e3a-accf-9460c147c365`.
It changed the city to Manchester and interests to `["Design"]`.

- Airtable created record `rechGEX3MMwuGb5UW`.
- Brevo preserved contact `3` and updated `CITY` to `Manchester`.
- Supabase created row `5b2054e9-3bd2-4e1e-aca6-f507938149f1`.
- An equivalent direct Brevo update returned the expected HTTP `204`.

### Failure isolation: verified

The Brevo consumer was stopped while Airtable, Supabase, and the producer remained running. A new
submission returned HTTP `202` for event `d879f5b8-45c2-462e-b5c2-3b4133afdf53`.

- Airtable immediately created record `recXZtI2dZzh3LiS6`.
- Supabase immediately created row `3ef64bf8-191d-4a7c-83aa-96c080cc1073`.
- RabbitMQ reported `messages_ready=1` and `consumers=0` for `city-group.events.brevo`.
- After Brevo restarted, the queue drained to zero and contact `4` was created for
  `isolation.check.4ward@example.com` with `CITY = Bristol`.

### Retry exhaustion and recovery: verified

The healthy Supabase consumer was replaced temporarily by a child process using only a test-local
override pointing at an unreachable URL. The repository `.env` was not changed. Event
`c7272a76-3b03-47b8-8568-e05830cd3663` produced this sanitized retry sequence:

```text
attempt 1: retryCount=0, RetryableError, scheduled nextRetryCount=1, delayMs=1000
attempt 2: retryCount=1, RetryableError, scheduled nextRetryCount=2, delayMs=2000
attempt 3: retryCount=2, RetryableError, scheduled nextRetryCount=3, delayMs=2000
attempt 4: retryCount=3, RetryableError, Dead-letter publication confirmed
```

The Supabase DLQ message contained `x-error-type: RetryableError` and `x-retry-count: 3`; the
message was inspected and acknowledged during cleanup. Airtable stored record
`recUukkLoBPrOzVaZ` and Brevo stored contact `5`, proving the failing Supabase path did not block
the other destinations.

The normal Supabase consumer was then restored. A new event
`73a69f8d-85a7-4c68-a2bd-90ed8829abf3` succeeded and produced Supabase row
`9e9e8837-6692-4396-a314-3d052809aeb5`.

### Graceful shutdown: verified

The producer and each consumer were stopped directly with `SIGINT`. Sanitized log excerpts:

```text
{"service":"airtable-consumer","signal":"SIGINT","msg":"Shutting down consumer"}
{"service":"brevo-consumer","signal":"SIGINT","msg":"Shutting down consumer"}
{"service":"supabase-consumer","signal":"SIGINT","msg":"Shutting down consumer"}
{"service":"producer","signal":"SIGINT","msg":"Shutting down producer"}
```

### Screenshot placeholders

Optional browser and dashboard images can be added under `docs/screenshots/`. Do not include API
keys, browser devtools headers, or other secret values in screenshots. See
[`docs/screenshots/README.md`](screenshots/README.md) for the intended filenames.

## Final repository checks

Verified on 2026-11-24:

```text
pnpm build                 -> exit 0
pnpm typecheck             -> exit 0
pnpm lint                  -> exit 0
pnpm format:check          -> All matched files use Prettier code style
pnpm test                  -> 7 files passed, 37 tests passed
pnpm test:integration      -> 1 file passed, 3 tests passed
docker compose config      -> exit 0
pnpm audit --prod          -> No known vulnerabilities found
```

Manual runtime smoke check with RabbitMQ running:

```text
GET /health       -> 200 {"status":"ok","rabbitmq":"ready"}
GET /             -> 200 text/html
POST /api/join    -> 202 {"status":"accepted","eventId":"..."}
```

The form was rendered at desktop `1440x1100` and mobile `390x844`. Both layouts kept the heading,
form controls, and primary action readable and operable without horizontal overflow.

Final secret scanning confirmed the live API keys exist only in the ignored `.env`, with no
credential values in tracked content. It also found no unsafe casts, TypeScript `any` usage,
non-null assertions, unfinished markers, or whitespace errors. `node_modules` and `dist` are
ignored by Git. `Architecture.md` and `CASE_STUDY.md` retain their original content and headings.
