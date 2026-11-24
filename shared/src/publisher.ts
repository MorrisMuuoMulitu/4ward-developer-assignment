import type { CityGroupJoinedEvent } from './contracts.js';

/**
 * Producer-facing port that keeps Fastify independent from the messaging implementation.
 */
export interface EventPublisher {
  isReady(): boolean;
  publish(event: CityGroupJoinedEvent): Promise<void>;
}
