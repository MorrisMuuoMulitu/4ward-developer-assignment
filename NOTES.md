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
- Delivery is at-least-once. Destination idempotency reduces duplicate effects but does not provide
  an exactly-once guarantee.
- External requests have a configurable hard timeout, and consumer shutdown has a bounded drain
  period.
- The prototype does not need authentication, rate limiting, auto-reconnection, or an outbox.
- Consumers must be started before the producer because RabbitMQ discards messages when no queue
  binding exists.

## Testing and verification

### 4. How did you verify the implementation beyond automated tests?

In addition to unit tests, I ran the producer against RabbitMQ and exercised the API routes,
mandatory publication failure, queue isolation, retry exhaustion, DLQ routing, and graceful
shutdown. The integration suite uses local HTTP servers for destination behavior so it never makes
live Airtable, Brevo, or Supabase calls.

The automated suite does not claim live external API verification. The post-hardening manual smoke
test below was performed separately against configured destination accounts.

#### Pre-hardening live verification record

The following evidence predates the hardening changes and is retained separately from current
mocked/local verification:

- Event `9354c080-c813-4958-9c75-1a3c4e5b05a1` created Airtable record
  `rechM1eplVuoWoZQQ`, Brevo contact `3`, and Supabase row
  `7d3ea957-035a-4733-9d44-c5493b106a21`.
- Event `f03e520e-685f-4e3a-accf-9460c147c365` updated Brevo contact `3` with HTTP `204` and
  created Airtable record `rechGEX3MMwuGb5UW` and Supabase row
  `5b2054e9-3bd2-4e1e-aca6-f507938149f1`.
- With Brevo stopped, event `d879f5b8-45c2-462e-b5c2-3b4133afdf53` reached Airtable and Supabase
  immediately, while one Brevo queue message waited for consumer recovery. Restarting Brevo
  created contact `4` for the synthetic isolation email in Bristol.

#### Post-hardening live smoke test

After the complete offline gate passed, one synthetic registration was sent through the hardened
system:

- Event ID: `ea7256d4-274e-4fb6-a80f-ad384f41817d`
- Airtable record: `rec5hlokOC0D9lXm2`
- Brevo contact: `7`
- Supabase row: `a9597da1-229f-456c-b525-7d3fdf71f1f7`
- Producer health: HTTP `200`
- Registration response: HTTP `202`

Each destination was independently read through its API. The producer and all three consumers shut
down cleanly on `SIGINT`, and RabbitMQ was stopped afterward.

### 5. Describe one failure scenario you tested.

The integration suite forces the first Airtable lookup to return HTTP `500`. The event is published
to the retry queue with incremented metadata, waits for the TTL, and succeeds on the next attempt.
A separate scenario uses `MAX_RETRY_ATTEMPTS=0` to verify that a retryable failure is confirmed to
the DLQ before the original delivery is acknowledged.

Malformed retry headers are tested separately and must go directly to the DLQ. A shutdown deadline
test leaves an in-flight delivery unacknowledged, closes the channel, and confirms RabbitMQ requeues
the message for a future consumer.

Pre-hardening live failure evidence: event `c7272a76-3b03-47b8-8568-e05830cd3663` exhausted
retries after delays of 1000 ms, 2000 ms, and 2000 ms, then reached the Supabase DLQ with
`x-retry-count: 3`. Airtable and Brevo continued successfully, and restored Supabase configuration
processed event `73a69f8d-85a7-4c68-a2bd-90ed8829abf3` into row
`9e9e8837-6692-4396-a314-3d052809aeb5`.

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

The broker flow was exercised with:

```bash
docker compose up -d rabbitmq
pnpm dev:airtable
pnpm dev:brevo
pnpm dev:supabase
pnpm dev:producer
docker exec 4ward-rabbitmq rabbitmqctl -q list_queues name messages_ready messages_unacknowledged consumers
```

I submitted requests to `POST /api/join`, verified health and form responses, inspected queue state,
and ran the integration scenarios above. External HTTP behavior was provided by local mock servers.
The final repository audit uses `git status --short`, `git diff --stat`, `git diff --check`, and
credential-value scans that exclude the ignored `.env`.

## Code and architecture

### 7. What changes would another destination require?

Add a consumer package containing its pure transformation, HTTP adapter, and runnable entrypoint.
Add its name to `CONSUMER_DESTINATIONS` so topology names are generated, and start its independent
process. The producer, event contract, and existing consumers do not change.

### 8. What was unclear or might you implement differently?

The brief permits two consumers while the full architecture and verification language reference all
three. I implemented all three to remove that ambiguity. For a production system I would replace
per-message TTL retry routing with one TTL queue per delay tier or a durable scheduler, and I would
add a transactional outbox between the producer and RabbitMQ. I would continue describing delivery
as at-least-once and retain destination-specific idempotency rather than claiming exactly-once.

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
