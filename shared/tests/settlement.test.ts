import { describe, expect, it } from 'vitest';

import { createSettlementGuard } from '../src/rabbit-consumer.js';

class RecordingSettlementChannel {
  public readonly actions: string[] = [];

  public ack(message: string): void {
    this.actions.push(`ack:${message}`);
  }

  public nack(message: string, allUpTo: boolean, requeue: boolean): void {
    this.actions.push(`nack:${message}:${String(allUpTo)}:${String(requeue)}`);
  }
}

describe('delivery settlement guard', () => {
  it('uses the current settlement state for every acknowledgement decision', () => {
    const channel = new RecordingSettlementChannel();
    let settlementAllowed = true;
    const settlement = createSettlementGuard(channel, 'delivery-1', () => settlementAllowed);

    settlement.ack();
    expect(channel.actions).toEqual(['ack:delivery-1']);

    settlementAllowed = false;
    settlement.ack();
    settlement.nack(true);

    expect(channel.actions).toEqual(['ack:delivery-1']);
  });

  it('prevents both ACK and NACK when settlement is disabled', () => {
    const channel = new RecordingSettlementChannel();
    const settlement = createSettlementGuard(channel, 'delivery-2', () => false);

    settlement.ack();
    settlement.nack(true);

    expect(channel.actions).toEqual([]);
  });
});
