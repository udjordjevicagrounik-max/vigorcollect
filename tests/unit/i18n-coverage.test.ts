import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json' with { type: 'json' };
import sr from '../../messages/sr-Latn.json' with { type: 'json' };
import { BULK_ACTIONS } from '@/server/bulk/service';
import { DISPUTE_STATUSES } from '@/server/disputes/service';
import { PROBE_ERRORS } from '@/server/integrations/mail-probe';
import { ONBOARDING_STEPS } from '@/server/onboarding/service';
import { REPORT_KEYS } from '@/server/reports/service';
import { EDITABLE_LISTS } from '@/server/settings/configuration';

// 5.4 i18n pass: keys built at runtime from code lists (statuses, actions, report keys, steps,
// probe errors) exist in BOTH en and sr-Latn — tsc cannot see a template-literal key.

const get = (messages: unknown, key: string) =>
  key
    .split('.')
    .reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], messages);

const REQUIRED = [
  ...DISPUTE_STATUSES.map((s) => `disputes.status.${s}`),
  ...DISPUTE_STATUSES.filter((s) => s !== 'open').map((s) => `disputes.to.${s}`),
  ...BULK_ACTIONS.map((a) => `bulk.actions.${a}`),
  ...REPORT_KEYS.flatMap((k) => [`reports.names.${k}`, `reports.definitions.${k}`]),
  ...ONBOARDING_STEPS.flatMap((s) => [`onboarding.steps.${s}.title`, `onboarding.steps.${s}.hint`]),
  ...PROBE_ERRORS.flatMap((e) => [`mailbox.errors.imap_${e}`, `mailbox.errors.smtp_${e}`]),
  ...EDITABLE_LISTS.filter((l) => l !== 'aging_bucket').map(
    (l) => `admin.configuration.lists.${l}`,
  ),
  ...['saved', 'test_requested', 'testing', 'connected', 'failed', 'none'].map(
    (s) => `mailbox.status.${s}`,
  ),
];

describe('i18n coverage of runtime keys (5.4)', () => {
  it('every runtime key exists in en and sr-Latn, non-empty', () => {
    const missing = REQUIRED.flatMap((key) =>
      [
        ['en', en],
        ['sr-Latn', sr],
      ]
        .filter(([, m]) => typeof get(m, key) !== 'string' || String(get(m, key)).trim() === '')
        .map(([locale]) => `${String(locale)}:${key}`),
    );
    expect(missing).toEqual([]);
  });
});
