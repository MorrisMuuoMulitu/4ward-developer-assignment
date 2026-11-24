export const CONSUMER_DESTINATIONS = ['airtable', 'brevo', 'supabase'] as const;

export type ConsumerDestination = (typeof CONSUMER_DESTINATIONS)[number];

export interface ConsumerQueueNames {
  readonly main: string;
  readonly retry: string;
  readonly deadLetter: string;
}

export interface ConsumerTopology {
  readonly destination: ConsumerDestination;
  readonly exchange: string;
  readonly queues: ConsumerQueueNames;
  readonly routingKey: string;
}

const TOPIC_ROUTING_KEY = 'city.group.joined';

export function topologyFor(exchange: string, destination: ConsumerDestination): ConsumerTopology {
  const main = `${exchange}.${destination}`;

  return {
    destination,
    exchange,
    queues: {
      main,
      retry: `${main}.retry`,
      deadLetter: `${main}.dlq`,
    },
    routingKey: TOPIC_ROUTING_KEY,
  };
}
