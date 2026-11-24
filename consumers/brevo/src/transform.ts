import type { CityGroupJoinedEvent } from '../../../shared/src/contracts.js';

export interface BrevoContact {
  readonly email: string;
  readonly attributes: {
    readonly NAME: string;
    readonly CITY: string;
    readonly COUNTRY: string;
  };
  readonly updateEnabled: true;
}

export function transformForBrevo(event: CityGroupJoinedEvent): BrevoContact {
  return {
    email: event.data.email,
    attributes: {
      NAME: event.data.name,
      CITY: event.data.city,
      COUNTRY: event.data.country,
    },
    updateEnabled: true,
  };
}
