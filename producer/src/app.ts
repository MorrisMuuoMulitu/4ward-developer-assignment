import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import type { z } from 'zod';

import {
  createCityGroupJoinedEvent,
  joinSubmissionSchema,
  type CityGroupJoinedEvent,
} from '../../shared/src/contracts.js';
import type { EventPublisher } from '../../shared/src/publisher.js';
import { joinFormPage } from './form-page.js';

interface ProducerAppOptions {
  readonly idGenerator?: () => string;
  readonly logger?: boolean | { readonly level: string };
  readonly now?: () => Date;
  readonly publisher: EventPublisher;
}

interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

function validationIssues(error: z.ZodError): readonly ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * Builds the producer without opening a network listener so route behavior can be tested directly.
 */
export async function createProducerApp(options: ProducerAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? { level: 'info' } });
  await app.register(formbody);

  const now = options.now ?? (() => new Date());
  const idGenerator = options.idGenerator;

  app.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(joinFormPage);
  });

  app.get('/health', async (_request, reply) => {
    if (!options.publisher.isReady()) {
      return reply.code(503).send({
        status: 'error',
        rabbitmq: 'unavailable',
      });
    }

    return reply.send({
      status: 'ok',
      rabbitmq: 'ready',
    });
  });

  app.post('/api/join', async (request, reply) => {
    const validation = joinSubmissionSchema.safeParse(request.body);

    if (!validation.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The join request is invalid.',
          details: validationIssues(validation.error),
        },
      });
    }

    const eventOptions =
      idGenerator === undefined ? { now: now() } : { eventId: idGenerator(), now: now() };
    let event: CityGroupJoinedEvent;

    try {
      event = createCityGroupJoinedEvent(validation.data, eventOptions);
    } catch (error) {
      request.log.error({ err: error }, 'Validated join submission did not create an event');
      return reply.code(500).send({
        error: {
          code: 'EVENT_CREATION_FAILED',
          message: 'The join request could not be processed.',
        },
      });
    }

    try {
      await options.publisher.publish(event);
    } catch (error) {
      request.log.error({ err: error }, 'Failed to publish CityGroupJoined event');
      return reply.code(503).send({
        error: {
          code: 'PUBLISH_FAILED',
          message: 'The join request could not be queued.',
        },
      });
    }

    return reply.code(202).send({
      status: 'accepted',
      eventId: event.eventId,
    });
  });

  return app;
}
