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

// TODO(0.2): read platform + tenant flags from `feature_flags`. Until then everything is off.
export async function isFlagEnabled(_flag: SettlementFlag): Promise<boolean> {
  return false;
}

export async function isAnySettlementFlagEnabled(): Promise<boolean> {
  const states = await Promise.all(SETTLEMENT_FLAGS.map((flag) => isFlagEnabled(flag)));
  return states.some(Boolean);
}
