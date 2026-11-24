import { RetryableError } from './errors.js';
import type { CityGroupJoinedEvent } from './contracts.js';
import type { EventPublisher } from './publisher.js';

export const EVENT_ROUTING_KEY = 'city.group.joined';

export interface ConfirmChannelLike {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: { readonly persistent?: boolean },
  ): boolean;
  waitForConfirms(): Promise<void>;
}

/**
 * Publishes persistent messages and waits for RabbitMQ publisher confirms.
 */
export class RabbitEventPublisher implements EventPublisher {
  private ready = true;

  public constructor(
    private readonly channel: ConfirmChannelLike,
    private readonly exchange: string,
  ) {}

  public isReady(): boolean {
    return this.ready;
  }

  public async publish(event: CityGroupJoinedEvent): Promise<void> {
    if (!this.ready) {
      throw new RetryableError('RabbitMQ publisher is unavailable.');
    }

    this.channel.publish(this.exchange, EVENT_ROUTING_KEY, Buffer.from(JSON.stringify(event)), {
      persistent: true,
    });
    await this.channel.waitForConfirms();
  }

  public markUnavailable(): void {
    this.ready = false;
  }
}
