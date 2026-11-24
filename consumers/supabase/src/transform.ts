import type { CityGroupJoinedEvent } from '../../../shared/src/contracts.js';

export interface SupabaseMemberRow {
  readonly name: string;
  readonly email: string;
  readonly city: string;
  readonly country: string;
  readonly interests: readonly string[];
  readonly event_id: string;
}

export function transformForSupabase(event: CityGroupJoinedEvent): SupabaseMemberRow {
  return {
    name: event.data.name,
    email: event.data.email,
    city: event.data.city,
    country: event.data.country,
    interests: event.data.interests,
    event_id: event.eventId,
  };
}
