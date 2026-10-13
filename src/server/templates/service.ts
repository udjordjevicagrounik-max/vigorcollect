import { z } from 'zod';
import type { Scope } from '@/server/auth/permissions';
import { scopeFilter } from '@/server/auth/scope';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  type TenantContext,
} from '@/server/auth/with-tenant';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { readCustomerName } from '@/server/customers/repository';
import type { Queryable } from '@/server/crypto/subject-keys';
import { emitEvent } from '@/server/events';
import { formatAmount } from '@/lib/format-amount';
import {
  render,
  TemplateError,
  validateTemplate,
  type InvoiceValues,
  type RenderContext,
} from './render';

/**
 * Templates (task 3.2). Reading: `settings.read`; a new version: `settings.manage`. Rendering
 * for a customer happens only through renderForCustomer(): the customer is loaded inside the
 * tenant (RLS) AND within the caller's scope (scopeFilter) — a template cannot reach another
 * tenant's or an out-of-scope customer, and can only print whitelisted variables (render.ts).
 * Amounts: decimal strings through Intl in the customer's language (rule 18, no float).
 */

export type TemplateSummary = {
  id: string;
  key: string;
  channel: 'email' | 'document';
  name: string;
  version: number;
  hasLegalEffect: boolean;
  texts: { locale: string; subject: string; body: string }[];
};

export async function listTemplates(ctx: TenantContext): Promise<TemplateSummary[]> {
  await ctx.requirePermission('settings.read');
  const { rows } = await ctx.db.query<{
    id: string;
    key: string;
    channel: 'email' | 'document';
    name: string;
    version: number;
    has_legal_effect: boolean;
    texts: { locale: string; subject: string; body: string }[] | null;
  }>(
    `SELECT t.id, t.key, t.channel, t.name, t.version, t.has_legal_effect,
            (SELECT json_agg(json_build_object('locale', x.locale, 'subject', x.subject, 'body', x.body) ORDER BY x.locale)
             FROM template_texts x WHERE x.template_id = t.id) AS texts
     FROM templates t WHERE t.status = 'active' ORDER BY t.channel, t.key`,
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    channel: r.channel,
    name: r.name,
    version: r.version,
    hasLegalEffect: r.has_legal_effect,
    texts: r.texts ?? [],
  }));
}

export const templateVersionSchema = z.object({
  texts: z
    .array(
      z.object({
        locale: z.string().regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/),
        subject: z.string().trim().min(1).max(300),
        body: z.string().trim().min(1).max(20000),
      }),
    )
    .min(1)
    .max(10),
});

/** A changed text is a NEW version; the old one is superseded (documents keep pointing to it). */
export async function saveTemplateVersion(
  ctx: TenantContext,
  templateId: string,
  input: z.input<typeof templateVersionSchema>,
): Promise<{ id: string; version: number }> {
  await ctx.requirePermission('settings.manage');
  const { texts } = templateVersionSchema.parse(input);
  for (const t of texts) {
    try {
      validateTemplate(t.subject, t.body);
    } catch (error) {
      if (error instanceof TemplateError) throw new InvalidRequestError();
      throw error;
    }
  }
  const { rows } = await ctx.db.query<{
    key: string;
    channel: string;
    name: string;
    version: number;
    has_legal_effect: boolean;
  }>(
    `SELECT key, channel, name, version, has_legal_effect FROM templates WHERE id = $1 AND status = 'active' FOR UPDATE`,
    [templateId],
  );
  const cur = rows[0];
  if (!cur) throw new NotFoundError();
  await ctx.db.query(`UPDATE templates SET status = 'superseded', updated_by = $2 WHERE id = $1`, [
    templateId,
    ctx.userId,
  ]);
  const ins = await ctx.db.query<{ id: string }>(
    `INSERT INTO templates (tenant_id, key, channel, name, version, has_legal_effect, created_by, updated_by)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $6) RETURNING id`,
    [cur.key, cur.channel, cur.name, cur.version + 1, cur.has_legal_effect, ctx.userId],
  );
  const id = ins.rows[0]?.id ?? '';
  for (const t of texts) {
    await ctx.db.query(
      `INSERT INTO template_texts (tenant_id, template_id, locale, subject, body, created_by)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5)`,
      [id, t.locale, t.subject, t.body, ctx.userId],
    );
  }
  await ctx.audit({
    action: 'template.version_saved',
    entityType: 'templates',
    entityId: id,
    after: {
      key: cur.key,
      channel: cur.channel,
      version: cur.version + 1,
      locales: texts.map((t) => t.locale),
    },
  });
  await emitEvent(ctx.db, {
    eventType: 'template.version_saved',
    aggregateType: 'templates',
    aggregateId: id,
    payload: { key: cur.key, version: cur.version + 1 },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { id, version: cur.version + 1 };
}

// ---------------------------------------------------------------------------------------------
// Context + render for one customer
// ---------------------------------------------------------------------------------------------

export type Rendered = {
  templateId: string;
  key: string;
  channel: 'email' | 'document';
  hasLegalEffect: boolean;
  locale: string;
  subject: string;
  html: string;
};

/** The customer within scope (for `permission`) or 404 — the only door into a render context. */
async function scopedCustomer(
  ctx: TenantContext,
  customerId: string,
  permission: string,
): Promise<Scope> {
  const { scope } = await ctx.requirePermission(permission);
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT c.id FROM customers c WHERE c.id = $1 AND ${filter.sql}`,
    [customerId, ...filter.params],
  );
  if (!rows.length) throw new NotFoundError();
  return scope;
}

async function buildContext(
  ctx: { db: Queryable; userId: string | null },
  keyring: MasterKeyring,
  customerId: string,
  opts: { invoiceId?: string | null; openOnly: 'overdue' | 'open'; locale: string },
): Promise<RenderContext> {
  const { rows } = await ctx.db.query<{
    is_natural_person: boolean;
    display_name: string | null;
    tax_id: string | null;
    external_id: string | null;
    company_name: string;
    company_tax_id: string | null;
    collector: string | null;
    open_total: string | null;
    overdue_total: string | null;
    currency: string;
    today: string;
  }>(
    `SELECT c.is_natural_person, c.display_name, le.tax_id, c.external_id,
            tc.display_name AS company_name, cle.tax_id AS company_tax_id,
            coalesce(u.display_name, me.display_name) AS collector,
            (SELECT sum(p.open_reporting) FROM invoice_positions p WHERE p.customer_id = c.id AND p.is_open)::text AS open_total,
            (SELECT sum(p.open_reporting) FROM invoice_positions p WHERE p.customer_id = c.id AND p.is_overdue)::text AS overdue_total,
            ts.default_currency AS currency,
            (now() AT TIME ZONE cle.timezone)::date::text AS today
     FROM customers c
     CROSS JOIN tenant_settings ts
     JOIN LATERAL (SELECT * FROM tenant_companies ORDER BY is_default DESC, created_at LIMIT 1) tc ON true
     JOIN legal_entities cle ON cle.id = tc.legal_entity_id
     LEFT JOIN legal_entities le ON le.id = c.legal_entity_id
     LEFT JOIN users u ON u.id = c.owner_user_id
     LEFT JOIN users me ON me.id = $2
     WHERE c.id = $1`,
    [customerId, ctx.userId],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError();
  const name = r.is_natural_person
    ? ((await readCustomerName(ctx.db, keyring, customerId)) ?? '')
    : (r.display_name ?? '');
  const date = (iso: string) =>
    new Intl.DateTimeFormat(opts.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(`${iso}T00:00:00Z`),
    );
  const inv = await ctx.db.query<{
    invoice_id: string;
    number: string;
    issue_date: string;
    due_date: string;
    amount_total: string;
    amount_open: string;
    currency: string;
    days_overdue: number;
  }>(
    `SELECT invoice_id, number, issue_date::text, due_date::text, amount_total, amount_open, currency, days_overdue
     FROM invoice_positions
     WHERE customer_id = $1 AND (CASE WHEN $2 = 'overdue' THEN is_overdue ELSE is_open END)
     ORDER BY due_date, number`,
    [customerId, opts.openOnly],
  );
  const values = (i: (typeof inv.rows)[number]): InvoiceValues => ({
    number: i.number,
    issue_date: date(i.issue_date),
    due_date: date(i.due_date),
    amount_total: formatAmount(i.amount_total, i.currency, opts.locale),
    amount_open: formatAmount(i.amount_open, i.currency, opts.locale),
    days_overdue: String(i.days_overdue),
  });
  const single = opts.invoiceId
    ? await ctx.db.query<(typeof inv.rows)[number]>(
        `SELECT invoice_id, number, issue_date::text, due_date::text, amount_total, amount_open, currency, days_overdue
         FROM invoice_positions WHERE invoice_id = $1 AND customer_id = $2`,
        [opts.invoiceId, customerId],
      )
    : null;
  if (opts.invoiceId && !single?.rows[0]) throw new NotFoundError();
  return {
    customer: {
      name,
      tax_id: r.is_natural_person ? '' : (r.tax_id ?? ''),
      external_id: r.external_id ?? '',
      open_total: formatAmount(r.open_total ?? '0.00', r.currency, opts.locale),
      overdue_total: formatAmount(r.overdue_total ?? '0.00', r.currency, opts.locale),
    },
    company: { name: r.company_name, tax_id: r.company_tax_id ?? '' },
    collector: { name: r.collector ?? '' },
    today: date(r.today),
    invoice: single?.rows[0] ? values(single.rows[0]) : null,
    invoices: inv.rows.map(values),
  };
}

type RenderInput = {
  key: string;
  channel: 'email' | 'document';
  customerId: string;
  invoiceId?: string | null;
  locale?: string | null | undefined;
};

async function renderWith(
  ctx: { db: Queryable; userId: string | null },
  input: RenderInput,
  keyring: MasterKeyring,
): Promise<Rendered> {
  const lang = await ctx.db.query<{ language: string | null; tenant_locale: string }>(
    `SELECT c.language, ts.default_locale AS tenant_locale FROM customers c CROSS JOIN tenant_settings ts WHERE c.id = $1`,
    [input.customerId],
  );
  if (!lang.rows[0]) throw new NotFoundError();
  const wanted = input.locale ?? lang.rows[0].language ?? lang.rows[0].tenant_locale ?? 'sr-Latn';
  const tpl = await ctx.db.query<{
    id: string;
    has_legal_effect: boolean;
    locale: string;
    subject: string;
    body: string;
  }>(
    `SELECT t.id, t.has_legal_effect, x.locale, x.subject, x.body
     FROM templates t JOIN template_texts x ON x.template_id = t.id
     WHERE t.key = $1 AND t.channel = $2 AND t.status = 'active'
     ORDER BY (x.locale = $3) DESC, (x.locale = 'sr-Latn') DESC LIMIT 1`,
    [input.key, input.channel, wanted],
  );
  const t = tpl.rows[0];
  if (!t) throw new ConflictError('unsupported');
  const context = await buildContext(ctx, keyring, input.customerId, {
    invoiceId: input.invoiceId ?? null,
    openOnly: input.key === 'statement' ? 'open' : 'overdue',
    locale: t.locale,
  });
  return {
    templateId: t.id,
    key: input.key,
    channel: input.channel,
    hasLegalEffect: t.has_legal_effect,
    locale: t.locale,
    subject: render(t.subject, context, 'text'),
    html: render(t.body, context, 'html'),
  };
}

/** A member renders for a customer within their scope (`permission`), or gets 404. */
export async function renderForCustomer(
  ctx: TenantContext,
  input: RenderInput & { permission: string },
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<Rendered> {
  await scopedCustomer(ctx, input.customerId, input.permission);
  return renderWith(ctx, input, keyring);
}

/**
 * The rule engine renders (3.3, queue_email) inside withTenantJob: no member, so no scope — but
 * still only this tenant's customer (RLS) and only whitelisted variables (render.ts). The
 * collector is the customer's owner; nothing else differs from renderForCustomer.
 */
export async function renderForJob(
  db: Queryable,
  input: RenderInput,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<Rendered> {
  return renderWith({ db, userId: null }, input, keyring);
}
