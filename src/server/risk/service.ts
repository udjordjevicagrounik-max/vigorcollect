import { z } from 'zod';
import { logEvent } from '@/lib/log';
import type { AuditEntry } from '@/server/auth/audit';
import { scopeFilter } from '@/server/auth/scope';
import { NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import type { Queryable } from '@/server/crypto/subject-keys';
import { emitEvent } from '@/server/events';
import { internalSignals } from './internal';
import { PROVIDERS } from './providers';
import type { ProviderAnswer, RiskProvider } from './providers/types';
import {
  computeScore,
  MODEL_VERSION,
  weightsSchema,
  type Explanation,
  type SignalValue,
} from './score';

/**
 * Risk (task 4.3, rules 19 / 11 / 35). Per customer:
 *   1. external providers of the customer's country (jurisdiction_profiles.risk_providers) are
 *      asked only when their last signals expired (valid_until — the cache); each call has a
 *      timeout, one retry for 'unavailable', a sync_runs row, and no personal data in the log;
 *      signals are stored only where the data source allows storing;
 *   2. internal signals (src/server/risk/internal.ts);
 *   3. a deterministic score with its explanation (score.ts) → risk_scores;
 *   4. a band that differs from customers.credit_status becomes a PROPOSAL (decisions, source
 *      'rule', type credit_status_<band>) — never a change. A person submits it: natural person →
 *      decision.approve (rule 19); company → customer.risk_override (approval.risk_override,
 *      rule 11). Only the checker's approval changes credit_status.
 */

const TIMEOUT_MS = 8_000;
type Audit = (entry: AuditEntry) => Promise<void>;

async function settings(db: Queryable) {
  const { rows } = await db.query<{ risk_weights: unknown; yellow: number; red: number }>(
    'SELECT risk_weights, risk_band_yellow AS yellow, risk_band_red AS red FROM tenant_settings',
  );
  const r = rows[0];
  return {
    weights: weightsSchema.parse(r?.risk_weights ?? {}),
    thresholds: { yellow: r?.yellow ?? 35, red: r?.red ?? 65 },
  };
}

async function ensureDataSource(
  db: Queryable,
  p: RiskProvider,
): Promise<{ id: string; mayStore: boolean }> {
  await db.query(
    `INSERT INTO data_sources (tenant_id, name, source_type, provider, may_display, may_store, retention_days,
                               may_derive, may_redistribute, may_onward_share)
     VALUES (app_tenant_id(), $1, $2, $1, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, name) DO NOTHING`,
    [
      p.sourceName,
      p.sourceType,
      p.rights.mayDisplay,
      p.rights.mayStore,
      p.rights.retentionDays,
      p.rights.mayDerive,
      p.rights.mayRedistribute,
      p.rights.mayOnwardShare,
    ],
  );
  const { rows } = await db.query<{ id: string; may_store: boolean }>(
    'SELECT id, may_store FROM data_sources WHERE name = $1',
    [p.sourceName],
  );
  return { id: rows[0]?.id ?? '', mayStore: rows[0]?.may_store ?? false };
}

async function withTimeout(
  p: RiskProvider,
  subject: Parameters<RiskProvider['fetch']>[0],
): Promise<ProviderAnswer> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    return await Promise.race([
      p.fetch(subject, signal),
      new Promise<ProviderAnswer>((resolve) =>
        signal.addEventListener('abort', () =>
          resolve({ status: 'unavailable', reason: 'timeout' }),
        ),
      ),
    ]);
  } catch {
    return { status: 'unavailable', reason: 'error' };
  }
}

/** External providers for one customer (cache by valid_until). Returns signals to score. */
export async function providerSignals(
  db: Queryable,
  customerId: string,
  now: Date = new Date(),
  providers: Record<string, RiskProvider> = PROVIDERS,
): Promise<SignalValue[]> {
  const { rows } = await db.query<{
    country: string | null;
    tax_id: string | null;
    reg: string | null;
    natural: boolean;
    keys: string[] | null;
  }>(
    `SELECT le.country_code AS country, le.tax_id, le.registration_number AS reg, c.is_natural_person AS natural,
            jp.risk_providers AS keys
     FROM customers c LEFT JOIN legal_entities le ON le.id = c.legal_entity_id
     LEFT JOIN jurisdiction_profiles jp ON jp.country_code = le.country_code
     WHERE c.id = $1`,
    [customerId],
  );
  const c = rows[0];
  // Companies only: providers are business registers / bureaus; consumers are never looked up.
  if (!c || c.natural || !c.country) return [];
  const out: SignalValue[] = [];
  for (const key of c.keys ?? []) {
    const p = providers[key];
    if (!p) continue;
    const source = await ensureDataSource(db, p);
    const cached = await db.query<{ value: string | null }>(
      `SELECT value::text FROM risk_signals
       WHERE customer_id = $1 AND source = $2 AND signal_type = 'external_blocked' AND valid_until > $3
       ORDER BY observed_at DESC LIMIT 1`,
      [customerId, p.key, now],
    );
    if (cached.rows[0]) {
      out.push({
        type: 'external_blocked',
        value: Number.parseInt(cached.rows[0].value ?? '0', 10),
        source: p.key,
      });
      continue;
    }
    const run = await db.query<{ id: string }>(
      `INSERT INTO sync_runs (tenant_id, provider, kind) VALUES (app_tenant_id(), $1, 'risk.fetch') RETURNING id`,
      [p.key],
    );
    const runId = run.rows[0]?.id ?? '';
    const subject = { countryCode: c.country, taxId: c.tax_id, registrationNumber: c.reg };
    let answer = await withTimeout(p, subject);
    if (answer.status === 'unavailable' && answer.reason !== 'not_configured')
      answer = await withTimeout(p, subject);
    let stored = 0;
    if (answer.status === 'ok') {
      for (const s of answer.signals) {
        out.push({ type: s.type, value: s.value, source: p.key });
        if (!source.mayStore) continue;
        await db.query(
          `INSERT INTO risk_signals (tenant_id, customer_id, signal_type, source, data_source_id, value, observed_at,
                                     valid_until, raw_ref)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            customerId,
            s.type,
            p.key,
            source.id,
            s.value,
            now,
            new Date(now.getTime() + answer.validForSeconds * 1000),
            s.rawRef ?? `sync_run:${runId}`,
          ],
        );
        stored += 1;
      }
    }
    const status =
      answer.status === 'ok'
        ? 'succeeded'
        : answer.status === 'unsupported'
          ? 'unsupported'
          : 'failed';
    await db.query(
      `UPDATE sync_runs SET status = $2, counts = $3, error_code = $4, finished_at = now() WHERE id = $1`,
      [
        runId,
        status,
        { signals: answer.status === 'ok' ? answer.signals.length : 0, stored },
        answer.status === 'ok' ? null : answer.reason,
      ],
    );
    logEvent('risk.provider', { provider: p.key, status, customerId, runId });
  }
  return out;
}

/** Scores one customer, stores the score and — if the band moved away from credit_status — a proposal. */
export async function computeRisk(
  db: Queryable,
  audit: Audit,
  customerId: string,
  opts: { now?: Date; providers?: Record<string, RiskProvider>; external?: boolean } = {},
): Promise<{
  score: number;
  band: 'green' | 'yellow' | 'red';
  explanation: Explanation;
  proposed: boolean;
}> {
  const now = opts.now ?? new Date();
  const cfg = await settings(db);
  const signals = [
    ...(await internalSignals(db, customerId)),
    ...(opts.external === false ? [] : await providerSignals(db, customerId, now, opts.providers)),
  ];
  const ext = signals.filter((s) => s.type === 'external_blocked');
  const merged: SignalValue[] = [
    ...signals.filter((s) => s.type !== 'external_blocked'),
    ext.length
      ? {
          type: 'external_blocked',
          value: Math.max(...ext.map((s) => s.value ?? 0)),
          source: ext.map((s) => s.source).join(','),
        }
      : { type: 'external_blocked', value: null, source: 'external', reason: 'no_provider_data' },
  ];
  const { score, band, explanation } = computeScore(merged, cfg.weights, cfg.thresholds);
  const prev = await db.query<{ band: string; credit_status: string; natural: boolean }>(
    `SELECT (SELECT band FROM risk_scores WHERE customer_id = c.id ORDER BY computed_at DESC LIMIT 1) AS band,
            c.credit_status, c.is_natural_person AS natural
     FROM customers c WHERE c.id = $1`,
    [customerId],
  );
  const before = prev.rows[0];
  if (!before) throw new NotFoundError();
  await db.query(
    `INSERT INTO risk_scores (tenant_id, customer_id, score, band, previous_band, explanation, model_version, computed_at)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
    [customerId, score, band, before.band ?? null, explanation, MODEL_VERSION, now],
  );
  if (before.band && before.band !== band) {
    await emitEvent(db, {
      eventType: 'risk.band_changed',
      aggregateType: 'customers',
      aggregateId: customerId,
      payload: { from: before.band, to: band, score },
    });
  }
  let proposed = false;
  if (before.credit_status !== band) {
    const open = await db.query(
      `SELECT 1 FROM decisions WHERE customer_id = $1 AND decision_type LIKE 'credit\\_status\\_%' AND status = 'proposed'`,
      [customerId],
    );
    if (!open.rowCount) {
      const d = await db.query<{ id: string }>(
        `INSERT INTO decisions (tenant_id, customer_id, decision_type, has_legal_effect, source, source_ref, status, rationale)
         VALUES (app_tenant_id(), $1, $2, $3, 'rule', $4, 'proposed', $5) RETURNING id`,
        [
          customerId,
          `credit_status_${band}`,
          band === 'red',
          `risk_score:${MODEL_VERSION}`,
          `score ${score} (${before.credit_status} → ${band})`,
        ],
      );
      await audit({
        action: 'decision.proposed',
        entityType: 'decisions',
        entityId: d.rows[0]?.id ?? null,
        after: { decision_type: `credit_status_${band}`, source: 'rule', status: 'proposed' },
      });
      proposed = true;
    }
  }
  return { score, band, explanation, proposed };
}

/** Daily job: every active customer with open invoices or an earlier score. */
export async function runDailyRisk(
  db: Queryable,
  audit: Audit,
  now: Date = new Date(),
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT c.id FROM customers c
     WHERE c.status <> 'inactive'
       AND (EXISTS (SELECT 1 FROM invoice_positions p WHERE p.customer_id = c.id AND p.is_open)
            OR EXISTS (SELECT 1 FROM risk_scores s WHERE s.customer_id = c.id))
     ORDER BY c.id LIMIT 2000`,
  );
  for (const r of rows) await computeRisk(db, audit, r.id, { now });
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// Reads for Customer 360 → Risk
// ---------------------------------------------------------------------------------------------

export type RiskView = {
  latest: { score: number; band: string; computedAt: string; explanation: Explanation } | null;
  history: { score: number; band: string; computedAt: string }[];
  creditStatus: string;
  providers: { provider: string; status: string; errorCode: string | null; at: string }[];
  pendingProposal: string | null;
};

async function scoped(ctx: TenantContext, customerId: string, permission: string) {
  const { scope } = await ctx.requirePermission(permission);
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT c.id FROM customers c WHERE c.id = $1 AND ${filter.sql}`,
    [customerId, ...filter.params],
  );
  if (!rows.length) throw new NotFoundError();
}

const explanationSchema = z.custom<Explanation>(
  (v) => typeof v === 'object' && v !== null && 'contributions' in v,
);

export async function getRisk(ctx: TenantContext, customerId: string): Promise<RiskView> {
  await scoped(ctx, customerId, 'customer.read');
  const scores = await ctx.db.query<{
    score: number;
    band: string;
    computed_at: Date;
    explanation: unknown;
  }>(
    `SELECT score, band, computed_at, explanation FROM risk_scores WHERE customer_id = $1
     ORDER BY computed_at DESC LIMIT 10`,
    [customerId],
  );
  const c = await ctx.db.query<{ credit_status: string }>(
    'SELECT credit_status FROM customers WHERE id = $1',
    [customerId],
  );
  const providers = await ctx.db.query<{
    provider: string;
    status: string;
    error_code: string | null;
    started_at: Date;
  }>(
    `SELECT DISTINCT ON (provider) provider, status, error_code, started_at FROM sync_runs
     WHERE kind = 'risk.fetch' ORDER BY provider, started_at DESC`,
  );
  const proposal = await ctx.db.query<{ decision_type: string }>(
    `SELECT decision_type FROM decisions WHERE customer_id = $1 AND decision_type LIKE 'credit\\_status\\_%'
       AND status = 'proposed' ORDER BY created_at DESC LIMIT 1`,
    [customerId],
  );
  const first = scores.rows[0];
  const parsed = first ? explanationSchema.safeParse(first.explanation) : null;
  return {
    latest:
      first && parsed?.success
        ? {
            score: first.score,
            band: first.band,
            computedAt: first.computed_at.toISOString(),
            explanation: parsed.data,
          }
        : null,
    history: scores.rows.map((r) => ({
      score: r.score,
      band: r.band,
      computedAt: r.computed_at.toISOString(),
    })),
    creditStatus: c.rows[0]?.credit_status ?? 'unrated',
    providers: providers.rows.map((r) => ({
      provider: r.provider,
      status: r.status,
      errorCode: r.error_code,
      at: r.started_at.toISOString(),
    })),
    pendingProposal: proposal.rows[0]?.decision_type ?? null,
  };
}

/** "Refresh now" from Customer 360 (customer.update): the same computation as the daily job. */
export async function refreshRisk(ctx: TenantContext, customerId: string) {
  await scoped(ctx, customerId, 'customer.update');
  const r = await computeRisk(ctx.db, ctx.audit, customerId);
  await ctx.audit({
    action: 'risk.refreshed',
    entityType: 'customers',
    entityId: customerId,
    after: { score: r.score, band: r.band, model_version: MODEL_VERSION },
  });
  return { score: r.score, band: r.band, proposed: r.proposed };
}
