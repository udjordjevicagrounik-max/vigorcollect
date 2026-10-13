import type { RiskProvider } from './types';

/**
 * APR — the Serbian business register (docs/integrations/apr.md). Public data (status, account
 * blocking note, published annual reports) is offered as a web search, not as a documented
 * public API; bulk open data is periodic. Until an agreed access path exists the adapter
 * answers 'unsupported' (no_public_api) — the score then simply has no external signal.
 * Available only where jurisdiction_profiles.risk_providers lists it (RS).
 */
export const apr: RiskProvider = {
  key: 'apr',
  sourceName: 'apr',
  sourceType: 'PUBLIC_REGISTER',
  rights: {
    mayDisplay: true,
    mayStore: true,
    retentionDays: 365,
    mayDerive: true,
    mayRedistribute: false,
    mayOnwardShare: false,
  },
  async fetch() {
    return { status: 'unsupported', reason: 'no_public_api' };
  },
};
