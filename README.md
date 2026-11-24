# 4WARD.earth City Group Integration

A TypeScript event-driven prototype for joining a city group. The Fastify producer validates
and publishes one `CityGroupJoined` event. Independent RabbitMQ consumers then create or update
records in Airtable, Brevo, and Supabase.

The supplied assignment is in [`CASE_STUDY.md`](CASE_STUDY.md), and the required topology is in
[`Architecture.md`](Architecture.md).

## Architecture

```text
Fastify producer
      |
      | CityGroupJoined, persistent publisher confirm
      v
city-group.events (durable topic exchange)
      |
      +--> city-group.events.airtable
      +--> city-group.events.brevo
      +--> city-group.events.supabase
```

Each destination queue has its own retry queue and dead-letter queue. Consumers acknowledge a
delivery only after the destination succeeds or a retry/dead-letter publication is confirmed.

## What Is Implemented

- Strict Fastify API validation with Zod.
- An accessible form at `GET /` and health check at `GET /health`.
- Canonical `CityGroupJoined` event creation with UUID and UTC timestamp.
- Persistent RabbitMQ publishing with publisher confirms.
- Mandatory routing so an unbound event is rejected instead of accepted.
- Three independent consumers, each with one destination responsibility.
- Airtable creation with an event-ID duplicate check.
- Brevo contact creation or update through `updateEnabled: true`.
- Supabase upsert on a unique `event_id`.
- Bounded retry routing with exponential per-message TTL and DLX return to the main queue.
- Terminal failures and exhausted retries routed to a durable DLQ.
- Manual acknowledgements, structured logs with secret redaction, and graceful in-flight drain.
- External API request timeouts and bounded consumer shutdown.
- Behavioral unit tests and a live RabbitMQ integration suite with mocked HTTP destinations.

## Requirements

- Node.js 20 or newer
- pnpm 11.22.0, as pinned in `package.json`
- Docker with Docker Compose
- Free Airtable, Brevo, and Supabase accounts for live destination verification

## Install

```bash
pnpm install
cp .env.example .env
```

Fill in the destination credentials in `.env`. Never commit that file.

Start RabbitMQ:

```bash
docker compose up -d rabbitmq
docker compose ps
```

The management interface is available at `http://localhost:15672`. Both RabbitMQ ports are bound
to loopback only.

## Environment

| Variable                      | Purpose                                           |
| ----------------------------- | ------------------------------------------------- |
| `NODE_ENV`                    | Runtime environment                               |
| `PORT`                        | Fastify port                                      |
| `LOG_LEVEL`                   | Pino log level                                    |
| `RABBITMQ_URL`                | Application AMQP URL                              |
| `RABBITMQ_EXCHANGE`           | Durable topic exchange name                       |
| `CONSUMER_PREFETCH`           | Maximum unacknowledged deliveries per consumer    |
| `RABBITMQ_DEFAULT_USER`       | Local RabbitMQ container user                     |
| `RABBITMQ_DEFAULT_PASS`       | Local RabbitMQ container password                 |
| `MAX_RETRY_ATTEMPTS`          | Retries allowed after the initial attempt         |
| `RETRY_INITIAL_DELAY_MS`      | First retry delay                                 |
| `RETRY_MAX_DELAY_MS`          | Maximum exponential retry delay                   |
| `EXTERNAL_REQUEST_TIMEOUT_MS` | Airtable, Brevo, and Supabase request timeout     |
| `SHUTDOWN_TIMEOUT_MS`         | Total bounded shutdown budget                     |
| `AIRTABLE_API_KEY`            | Airtable personal access token                    |
| `AIRTABLE_BASE_ID`            | Airtable base identifier                          |
| `AIRTABLE_TABLE_NAME`         | Airtable table name, default `City Group Members` |
| `BREVO_API_KEY`               | Brevo API key                                     |
| `SUPABASE_URL`                | Supabase project URL                              |
| `SUPABASE_SECRET_KEY`         | Server-only `sb_secret_` API key, preferred       |
| `SUPABASE_SERVICE_ROLE_KEY`   | Legacy server-only service role key fallback      |

## Destination Setup

Create the Airtable table with these exact fields:

- `Name`: Single line text
- `Email`: Email
- `City`: Single line text
- `Country`: Single line text
- `Interests`: Long text
- `Event ID`: Single line text

Create the Brevo attributes `NAME`, `CITY`, and `COUNTRY`.

Apply [`supabase/migrations/202611240001_create_city_group_members.sql`](supabase/migrations/202611240001_create_city_group_members.sql)
through the Supabase SQL editor or a migration tool. The unique `event_id` constraint is required
for idempotent upserts.

## Run

Start the three consumers before the producer so the exchange has active queue bindings. Use a
separate terminal for each command:

```bash
pnpm dev:airtable
pnpm dev:brevo
pnpm dev:supabase
pnpm dev:producer
```

Open `http://localhost:3000`, or submit JSON directly:

```bash
curl --fail-with-body \
  --request POST \
  --header 'content-type: application/json' \
  --data '{
    "name": "Jane Doe",
    "email": "jane@example.com",
    "city": "London",
    "country": "United Kingdom",
    "interests": ["Technology", "Climate"]
  }' \
  http://localhost:3000/api/join
```

A successful publication returns HTTP `202` with the event ID. Validation failures return
HTTP `400`, and an unavailable broker returns HTTP `503`.

## Tests

Unit and behavioral tests do not require external credentials:

```bash
pnpm test
```

The integration suite requires a healthy RabbitMQ container:

```bash
docker compose up -d rabbitmq
pnpm test:integration
```

It verifies delivery to all three queues, failure isolation, mandatory unroutable rejection,
temporary failure recovery, retry exhaustion into the DLQ, graceful draining, and shutdown-deadline
requeue behavior.

Full repository checks:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:integration
docker compose config
pnpm audit --prod
```

## Stop

Stop applications with `Ctrl+C`. Stop RabbitMQ while retaining its messages:

```bash
docker compose down
```

To remove the RabbitMQ data volume as well:

```bash
docker compose down --volumes
```

The volume command deletes queued messages and must be used intentionally.

`SHUTDOWN_TIMEOUT_MS` is one total budget shared by subscription cancellation, in-flight delivery
drain, HTTP server close, channel close, and connection close. Deadline timers are unref'ed. If the
deadline expires, unacknowledged messages are left for RabbitMQ to requeue after channel closure.

## Retry And Acknowledgement Semantics

The initial delivery has retry count `0`. A retryable failure publishes the original event to the
destination's retry queue with `x-retry-count` incremented. The retry message has a per-message TTL
and dead-letters through the default exchange back to the main queue.

`MAX_RETRY_ATTEMPTS` counts retries after the initial attempt. For example, `3` permits one initial
attempt and three retries. HTTP `408`, HTTP `429`, HTTP `5xx`, network failures, and request
timeouts are retryable. Other HTTP responses are terminal. Invalid retry metadata is sent directly
to the DLQ with a diagnostic reason. A confirmed retry or DLQ publication is followed by an
acknowledgement; if that publication cannot be confirmed, the original delivery is nacked and
requeued.

Every producer and retry/DLQ publication uses a unique AMQP `messageId`. A persistent return
listener correlates `basic.return` back to the specific pending attempt before its confirm callback
settles. Returned messages, negative confirms, channel errors, and channel closure reject the
publication attempt.

RabbitMQ per-message TTL is appropriate for this prototype but has head-of-line expiry behaviour
when messages with different delays are interleaved. A larger system should use one TTL queue per
delay tier or a dedicated scheduler.

## Idempotency

- Supabase uses `UNIQUE(event_id)` and `resolution=merge-duplicates`.
- Brevo uses email as its contact identity and `updateEnabled: true`.
- Airtable queries the `Event ID` field before creating a record. Airtable cannot enforce a unique
  constraint on an ordinary field, so a concurrent check-and-create race remains possible.

## Operational Tradeoffs

- The producer uses publisher confirms but not a transactional outbox. A failed publication
  returns `503`; success means RabbitMQ confirmed the event was routable and accepted.
- Delivery is at-least-once. Destinations use event-specific idempotency where their APIs permit.
- Consumers should be running before the producer publishes. Mandatory publishing rejects events
  with no matching queue binding instead of returning false success.
- The local prototype does not implement producer authentication, rate limiting, or automatic
  RabbitMQ reconnection. Those are outside the supplied scope.
- The Supabase service role key bypasses Row Level Security and must remain server-side.

## Project Structure

```text
producer/                 Fastify app, event submission route, form
consumers/airtable/       Airtable transformation and API client
consumers/brevo/          Brevo transformation and API client
consumers/supabase/       Supabase transformation and API client
shared/                   contracts, configuration, RabbitMQ runtime, errors
supabase/migrations/      city_group_members table
tests/integration/        live RabbitMQ flow tests
docs/verification.md      automated and live verification evidence
NOTES.md                  implementation reasoning and assignment answers
```

## Candidate Task

The original candidate task remains preserved in [`CASE_STUDY.md`](CASE_STUDY.md). The
assignment permits any two consumers; this implementation includes all three so the complete
supplied architecture can be verified.
