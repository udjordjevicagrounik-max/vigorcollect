// Settlement flags (rule 31). Off by default; Resolution nav group is hidden while all are off.
export const SETTLEMENT_FLAGS = [
  'settlement.bilateral',
  'settlement.multilateral_manual',
  'settlement.engine',
  'settlement.room',
  'settlement.partner_desk',
  'settlement.network',
  'settlement.marketplace',
] as const;

export type SettlementFlag = (typeof SETTLEMENT_FLAGS)[number];

// Tables exist since 0.2a (`platform_feature_flags` + `feature_flags`, effective = platform AND
// tenant). TODO(1.3): read them through withTenant() once it exists. Until then everything is off.
export async function isFlagEnabled(_flag: SettlementFlag): Promise<boolean> {
  return false;
}

export async function isAnySettlementFlagEnabled(): Promise<boolean> {
  const states = await Promise.all(SETTLEMENT_FLAGS.map((flag) => isFlagEnabled(flag)));
  return states.some(Boolean);
}
