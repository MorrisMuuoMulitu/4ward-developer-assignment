import type { CityGroupJoinedEvent } from '../../../shared/src/contracts.js';

export interface AirtableFields {
  readonly Name: string;
  readonly Email: string;
  readonly City: string;
  readonly Country: string;
  readonly Interests: string;
  readonly 'Event ID': string;
}

export function transformForAirtable(event: CityGroupJoinedEvent): AirtableFields {
  return {
    Name: event.data.name,
    Email: event.data.email,
    City: event.data.city,
    Country: event.data.country,
    Interests: event.data.interests.join(', '),
    'Event ID': event.eventId,
  };
}
