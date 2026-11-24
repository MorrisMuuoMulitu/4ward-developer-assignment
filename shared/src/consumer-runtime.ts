import { parseCityGroupJoinedEvent } from './contracts.js';
import { isRetryableError } from './errors.js';

export const RETRY_COUNT_HEADER = 'x-retry-count';

export interface ConsumerQueueNames {
  readonly main: string;
  readonly retry: string;
  readonly deadLetter: string;
}

export interface ConsumerDelivery {
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, unknown>>;
  ack(): void;
  nack(requeue: boolean): void;
}

export interface QueuePublishOptions {
  readonly expiration?: string;
  readonly persistent?: boolean;
}

export interface ConfirmedQueuePublisher {
  publish(
    queue: string,
    body: Buffer,
    headers: Readonly<Record<string, unknown>>,
    options: QueuePublishOptions,
  ): Promise<void>;
}

export interface MessageLogger {
  info(context: Readonly<Record<string, unknown>>, message: string): void;
  error(context: Readonly<Record<string, unknown>>, message: string): void;
}

export interface ProcessConsumerMessageOptions {
  readonly delivery: ConsumerDelivery;
  readonly handler: (event: ReturnType<typeof parseCityGroupJoinedEvent>) => Promise<void>;
  readonly logger: MessageLogger;
  readonly maxRetryAttempts: number;
  readonly publisher: ConfirmedQueuePublisher;
  readonly queues: ConsumerQueueNames;
  readonly retryInitialDelayMs: number;
  readonly retryMaxDelayMs: number;
}

export type ProcessOutcome = 'success' | 'retry' | 'dead-letter' | 'requeued';

function retryCountFromHeaders(headers: Readonly<Record<string, unknown>>): number {
  const raw = headers[RETRY_COUNT_HEADER];

  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }

  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  return 0;
}

/**
 * Exponential backoff is capped so a bad configuration cannot create excessive delay.
 */
export function calculateRetryDelayMs(
  retryCount: number,
  initialDelayMs: number,
  maxDelayMs: number,
): number {
  return Math.min(initialDelayMs * 2 ** retryCount, maxDelayMs);
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Applies the consumer acknowledgement invariant: a delivery is acknowledged only after
 * successful processing or after a confirmed retry/dead-letter publication.
 */
export async function processConsumerMessage(
  options: ProcessConsumerMessageOptions,
): Promise<ProcessOutcome> {
  const { delivery, handler, logger, publisher, queues } = options;
  const retryCount = retryCountFromHeaders(delivery.headers);
  let event: ReturnType<typeof parseCityGroupJoinedEvent>;

  try {
    const parsed: unknown = JSON.parse(delivery.body.toString('utf8'));
    event = parseCityGroupJoinedEvent(parsed);
  } catch (error) {
    logger.error(
      { errorType: errorType(error), queue: queues.main, retryCount },
      'Dead-lettering invalid CityGroupJoined event',
    );
    return routeToDeadLetter({ ...options, delivery, error: error, publisher, retryCount });
  }

  try {
    await handler(event);
    delivery.ack();
    logger.info(
      { eventId: event.eventId, queue: queues.main, retryCount },
      'Consumer processing succeeded',
    );
    return 'success';
  } catch (error) {
    logger.error(
      {
        errorType: errorType(error),
        eventId: event.eventId,
        queue: queues.main,
        retryCount,
      },
      'Consumer processing failed',
    );

    if (isRetryableError(error) && retryCount < options.maxRetryAttempts) {
      const nextRetryCount = retryCount + 1;
      const delayMs = calculateRetryDelayMs(
        retryCount,
        options.retryInitialDelayMs,
        options.retryMaxDelayMs,
      );

      try {
        await publisher.publish(
          queues.retry,
          delivery.body,
          {
            ...delivery.headers,
            [RETRY_COUNT_HEADER]: nextRetryCount,
          },
          {
            expiration: String(delayMs),
            persistent: true,
          },
        );
        delivery.ack();
        logger.info(
          {
            delayMs,
            eventId: event.eventId,
            nextRetryCount,
            queue: queues.retry,
          },
          'Scheduled event retry',
        );
        return 'retry';
      } catch (publishError) {
        logger.error(
          {
            errorType: errorType(publishError),
            eventId: event.eventId,
            queue: queues.retry,
          },
          'Retry publication was not confirmed; requeueing original delivery',
        );
        delivery.nack(true);
        return 'requeued';
      }
    }

    return routeToDeadLetter({
      ...options,
      delivery,
      error,
      publisher,
      retryCount,
    });
  }
}

type DeadLetterOptions = ProcessConsumerMessageOptions & {
  readonly delivery: ConsumerDelivery;
  readonly error: unknown;
  readonly publisher: ConfirmedQueuePublisher;
  readonly retryCount: number;
};

async function routeToDeadLetter(options: DeadLetterOptions): Promise<ProcessOutcome> {
  try {
    await options.publisher.publish(
      options.queues.deadLetter,
      options.delivery.body,
      {
        ...options.delivery.headers,
        [RETRY_COUNT_HEADER]: options.retryCount,
        'x-error-type': errorType(options.error),
      },
      { persistent: true },
    );
    options.delivery.ack();
    options.logger.info(
      {
        errorType: errorType(options.error),
        queue: options.queues.deadLetter,
        retryCount: options.retryCount,
      },
      'Dead-letter publication confirmed',
    );
    return 'dead-letter';
  } catch (error) {
    options.logger.error(
      {
        errorType: errorType(error),
        queue: options.queues.deadLetter,
      },
      'Dead-letter publication was not confirmed; requeueing original delivery',
    );
    options.delivery.nack(true);
    return 'requeued';
  }
}
