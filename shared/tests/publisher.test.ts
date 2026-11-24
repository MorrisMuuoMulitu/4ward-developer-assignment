import { describe, expect, it } from 'vitest';

import { createCityGroupJoinedEvent } from '../src/contracts.js';
import { RabbitEventPublisher, type ConfirmChannelLike } from '../src/rabbit-publisher.js';

class RecordingConfirmChannel implements ConfirmChannelLike {
  public confirmCount = 0;
  public readonly publishes: {
    readonly exchange: string;
    readonly options: { readonly persistent?: boolean };
    readonly routingKey: string;
  }[] = [];

  public publish(
    exchange: string,
    routingKey: string,
    _content: Buffer,
    options: { readonly persistent?: boolean },
  ): boolean {
    this.publishes.push({ exchange, options, routingKey });
    return true;
  }

  public waitForConfirms(): Promise<void> {
    this.confirmCount += 1;
    return Promise.resolve();
  }
}

describe('RabbitEventPublisher', () => {
  it('publishes the canonical event persistently and waits for confirmation', async () => {
    const channel = new RecordingConfirmChannel();
    const publisher = new RabbitEventPublisher(channel, 'city-group.events');
    const event = createCityGroupJoinedEvent(
      {
        name: 'Jane Doe',
        email: 'jane@example.com',
        city: 'London',
        country: 'United Kingdom',
        interests: ['Technology'],
      },
      {
        eventId: '7eec8d9b-ee33-4bdf-a63c-0bd9377fbde6',
        now: new Date('2026-11-16T10:30:00.000Z'),
      },
    );

    await publisher.publish(event);

    expect(channel.publishes).toHaveLength(1);
    expect(channel.publishes[0]).toMatchObject({
      exchange: 'city-group.events',
      options: { persistent: true },
      routingKey: 'city.group.joined',
    });
    expect(channel.confirmCount).toBe(1);
  });
});
