import { apr } from './apr';
import { checkpoint } from './checkpoint';
import { nbs } from './nbs';
import type { RiskProvider } from './types';

/** Adapters by key; WHICH apply to a customer comes from jurisdiction_profiles.risk_providers. */
export const PROVIDERS: Record<RiskProvider['key'], RiskProvider> = { checkpoint, apr, nbs };
