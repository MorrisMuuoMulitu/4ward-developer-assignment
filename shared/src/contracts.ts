import { randomUUID } from 'node:crypto';

import { z } from 'zod';

const textFieldSchema = z.string().trim().min(1).max(120);
const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

function normalizeInterests(value: unknown): unknown {
  if (value === undefined || value === null) {
    return [];
  }

  if (typeof value === 'string') {
    return value.split(',');
  }

  if (Array.isArray(value)) {
    const normalized: unknown[] = [];

    for (const item of value) {
      if (typeof item === 'string') {
        normalized.push(...item.split(','));
      } else {
        normalized.push(item);
      }
    }

    return normalized;
  }

  return value;
}

function uniqueInterests(interests: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const interest of interests) {
    const trimmed = interest.trim();

    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }

  return normalized;
}

const interestsSchema = z
  .preprocess(normalizeInterests, z.array(z.string().max(80)).max(25))
  .transform(uniqueInterests);

/**
 * Accepts JSON arrays as well as the comma-separated strings produced by HTML forms.
 */
export const joinSubmissionSchema = z.strictObject({
  name: textFieldSchema,
  email: emailSchema,
  city: textFieldSchema,
  country: textFieldSchema,
  interests: interestsSchema,
});

export const cityGroupJoinedEventSchema = z.strictObject({
  event: z.literal('CityGroupJoined'),
  eventId: z.uuid(),
  timestamp: z.iso.datetime({ offset: true }),
  data: z.strictObject({
    name: textFieldSchema,
    email: emailSchema,
    city: textFieldSchema,
    country: textFieldSchema,
    interests: z.array(z.string().min(1).max(80)).max(25),
  }),
});

export interface JoinSubmission {
  readonly name: string;
  readonly email: string;
  readonly city: string;
  readonly country: string;
  readonly interests: readonly string[];
}

export interface CityGroupJoinedEvent {
  readonly event: 'CityGroupJoined';
  readonly eventId: string;
  readonly timestamp: string;
  readonly data: JoinSubmission;
}

export interface EventFactoryOptions {
  readonly eventId?: string;
  readonly now?: Date;
}

function freezeSubmission(submission: JoinSubmission): JoinSubmission {
  return Object.freeze({
    name: submission.name,
    email: submission.email,
    city: submission.city,
    country: submission.country,
    interests: Object.freeze([...submission.interests]),
  });
}

/**
 * Builds the canonical event only after passing the shared validation contract.
 */
export function createCityGroupJoinedEvent(
  submission: JoinSubmission,
  options: EventFactoryOptions = {},
): CityGroupJoinedEvent {
  const parsed = joinSubmissionSchema.parse(submission);
  const event: CityGroupJoinedEvent = {
    event: 'CityGroupJoined',
    eventId: options.eventId ?? randomUUID(),
    timestamp: (options.now ?? new Date()).toISOString(),
    data: freezeSubmission(parsed),
  };

  return Object.freeze(event);
}

/**
 * Consumers use this guard before invoking destination adapters.
 */
export function parseCityGroupJoinedEvent(input: unknown): CityGroupJoinedEvent {
  const parsed = cityGroupJoinedEventSchema.parse(input);

  return Object.freeze({
    event: parsed.event,
    eventId: parsed.eventId,
    timestamp: parsed.timestamp,
    data: freezeSubmission(parsed.data),
  });
}
