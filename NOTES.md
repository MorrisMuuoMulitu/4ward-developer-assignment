# Candidate Notes

## Implementation

### 1. What was the most important implementation decision you made, and why?

I gave each destination its own durable queue, consumer process, retry queue, and DLQ. This makes
failure isolation a property of the messaging topology rather than a convention inside one shared
worker. It also allowed the acknowledgement invariant to stay simple: the original delivery is
acknowledged only after destination success or a confirmed handoff to retry/DLQ storage.

### 2. What was the most difficult part, and how did you investigate and resolve it?

The difficult part was preserving acknowledgement correctness across retries and shutdown. I
tested the real RabbitMQ topology rather than relying on channel mocks. That exposed an in-flight
delivery being nacked after its channel had already closed. I changed the consumer runtime to stop
new intake, await all current deliveries, and only then close the channel. The integration suite
now proves that shutdown waits for the active handler.

### 3. What assumptions did you make?

- `MAX_RETRY_ATTEMPTS` counts retries after the initial delivery.
- Interests are trimmed, comma-split for forms, empty entries removed, and duplicates removed.
- Supabase may add a uniqueness requirement on `event_id`; this is needed for safe upserts.
- Current `sb_secret_` Supabase keys are accepted through `SUPABASE_SECRET_KEY`; the legacy
  `SUPABASE_SERVICE_ROLE_KEY` remains a fallback.
- Brevo treats email as contact identity, so later events update the existing contact.
- Airtable duplicate prevention is best-effort because ordinary Airtable fields are not unique.
- The prototype does not need authentication, rate limiting, auto-reconnection, or an outbox.
- Consumers must be started before the producer because RabbitMQ discards messages when no queue
  binding exists.

## Testing and verification

### 4. How did you verify the implementation beyond automated tests?

The real producer, RabbitMQ, and all three consumers were run together. A Jane Doe submission for
`jane.4ward.verify@example.com` returned HTTP `202` for event
`9354c080-c813-4958-9c75-1a3c4e5b05a1` and created:

- Airtable record `rechM1eplVuoWoZQQ`
- Brevo contact `3`
- Supabase row `7d3ea957-035a-4733-9d44-c5493b106a21`

I read each destination back through its API and matched every submitted field and the event ID.
A second request for the same email, event `f03e520e-685f-4e3a-accf-9460c147c365`, returned the
expected Brevo HTTP `204`, updated contact `3`, and created new Airtable and Supabase records.

I also stopped Brevo while the other consumers remained active. Airtable and Supabase persisted
event `d879f5b8-45c2-462e-b5c2-3b4133afdf53` immediately, while the durable Brevo queue held one
message with zero consumers. Restarting Brevo drained that queue and created contact `4`.

### 5. Describe one failure scenario you tested.

For a live retry test, I replaced the healthy Supabase consumer temporarily with a child process
whose `SUPABASE_URL` pointed at an unreachable local port. This override existed only in that
child process; `.env` was not changed.

Event `c7272a76-3b03-47b8-8568-e05830cd3663` failed four times in total with `RetryableError`.
The retry counts progressed through `0`, `1`, `2`, and `3`, with delays of 1000 ms, 2000 ms, and
2000 ms. The exhausted message reached `city-group.events.supabase.dlq` with `x-retry-count: 3`
and `x-error-type: RetryableError`.

Airtable and Brevo processed the same event successfully while Supabase was failing. I then
restored the normal Supabase consumer; event `73a69f8d-85a7-4c68-a2bd-90ed8829abf3` succeeded
and created row `9e9e8837-6692-4396-a314-3d052809aeb5`.

### 6. What checks did you run before submission?

The implemented automated gates are:

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

The live flow was exercised with:

```bash
docker compose up -d rabbitmq
pnpm dev:airtable
pnpm dev:brevo
pnpm dev:supabase
pnpm dev:producer
docker exec 4ward-rabbitmq rabbitmqctl -q list_queues name messages_ready messages_unacknowledged consumers
```

I submitted requests to `POST /api/join`, then queried each destination through its API using the
submitted email and event ID. For the retry test I used:

```bash
SUPABASE_URL=http://127.0.0.1:9 \
SUPABASE_SECRET_KEY=retry-test-only \
MAX_RETRY_ATTEMPTS=3 \
RETRY_INITIAL_DELAY_MS=1000 \
RETRY_MAX_DELAY_MS=2000 \
pnpm exec tsx consumers/supabase/src/index.ts
```

The final repository audit used `git status --short`, `git diff --stat`, `git diff --check`, and
credential-value scans that excluded the ignored `.env`.

## Code and architecture

### 7. What changes would another destination require?

Add a consumer package containing its pure transformation, HTTP adapter, and runnable entrypoint.
Add its name to `CONSUMER_DESTINATIONS` so topology names are generated, and start its independent
process. The producer, event contract, and existing consumers do not change.

### 8. What was unclear or might you implement differently?

The brief permits two consumers while the full architecture and verification language reference all
three. I implemented all three to remove that ambiguity. For a production system I would replace
per-message TTL retry routing with one TTL queue per delay tier or a durable scheduler, and I would
add a transactional outbox between the producer and RabbitMQ.

## Development process

### 9. What tools did you use?

TypeScript, Fastify, Zod, amqplib, pnpm, Vitest, ESLint, Prettier, Pino, Docker, and RabbitMQ. I
used an AI coding assistant for implementation and review support, then validated the result with
the behavioral and live RabbitMQ test suites.

### 10. Identify an approach suggested by a tool that you changed or verified.

The initial consumer shutdown closed the channel immediately on `SIGINT` or `SIGTERM`. The live
RabbitMQ test exposed that an in-flight handler could then attempt `nack` on a closed channel. I
rejected that approach, wrote a failing drain test, and changed shutdown to cancel intake and wait
for in-flight deliveries before closing the channel.
