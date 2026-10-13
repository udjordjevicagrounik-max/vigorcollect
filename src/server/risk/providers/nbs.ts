import type { RiskProvider } from './types';

/**
 * NBS — enforced collection / blocked accounts (docs/integrations/nbs.md). The public lookup is
 * an interactive web form; the web service needs a registered user. Without that access the
 * adapter answers 'unsupported' (no_public_api) instead of scraping the form.
 */
export const nbs: RiskProvider = {
  key: 'nbs',
  sourceName: 'nbs',
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
