import type { RiskProvider } from './types';

/**
 * CheckPoint (docs/integrations/checkpoint.md). The trial key comes from CHECKPOINT_API_KEY
 * (set by Uroš in the environment, never in the chat or the repo). The API reference has not
 * been provided yet, so this adapter does NOT guess endpoints: with a key it answers
 * 'unsupported' (api_not_documented), without one 'unavailable' (not_configured). Rights per the
 * trial terms as given: display yes, store yes, redistribute NO.
 */
export const checkpoint: RiskProvider = {
  key: 'checkpoint',
  sourceName: 'checkpoint',
  sourceType: 'CREDIT_BUREAU',
  rights: {
    mayDisplay: true,
    mayStore: true,
    retentionDays: 365,
    mayDerive: true,
    mayRedistribute: false,
    mayOnwardShare: false,
  },
  async fetch() {
    if (!process.env.CHECKPOINT_API_KEY) return { status: 'unavailable', reason: 'not_configured' };
    return { status: 'unsupported', reason: 'api_not_documented' };
  },
};
