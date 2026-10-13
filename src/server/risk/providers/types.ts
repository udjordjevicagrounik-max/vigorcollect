/**
 * RiskProvider (task 4.3, rule 35): one adapter per external source. Every provider declares the
 * rights its data comes with (they become the tenant's data_sources row) and answers for one
 * company identified by country + tax id / registration number. Adapters never invent an API:
 * a source without a documented API is a stub that answers 'unsupported' (docs/integrations).
 */

export type ProviderRights = {
  mayDisplay: boolean;
  mayStore: boolean;
  retentionDays: number;
  mayDerive: boolean;
  mayRedistribute: boolean;
  mayOnwardShare: boolean;
};

export type ProviderSubject = {
  countryCode: string;
  taxId: string | null;
  registrationNumber: string | null;
};

export type ProviderSignal = { type: 'external_blocked'; value: number; rawRef: string | null };

export type ProviderAnswer =
  | { status: 'ok'; signals: ProviderSignal[]; validForSeconds: number }
  | { status: 'unsupported'; reason: string }
  | { status: 'unavailable'; reason: string };

export type RiskProvider = {
  key: 'checkpoint' | 'apr' | 'nbs';
  /** data_sources.name (per tenant) and source_type. */
  sourceName: string;
  sourceType: string;
  rights: ProviderRights;
  fetch(subject: ProviderSubject, signal: AbortSignal): Promise<ProviderAnswer>;
};
