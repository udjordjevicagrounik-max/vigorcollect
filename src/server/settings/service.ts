import { z } from 'zod';
import { LOCALES } from '@/i18n/config';
import { ConflictError, InvalidRequestError, type TenantContext } from '@/server/auth/with-tenant';
import { emitEvent } from '@/server/events';

/**
 * Tenant settings (task 1.5): language, time zone, currency, country (rule 25 — country-dependent
 * parameters come from jurisdiction_profiles via country_code). A change writes audit (before /
 * after, P0 columns) and a domain event in the same transaction.
 */

export type TenantSettings = {
  tenantName: string;
  defaultLocale: string;
  timezone: string;
  defaultCurrency: string;
  countryCode: string;
};

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone').concat('UTC'));
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export const settingsSchema = z.object({
  defaultLocale: z.enum(LOCALES),
  timezone: z.string().refine((tz) => TIMEZONES.has(tz), 'unknown time zone'),
  defaultCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .refine((c) => CURRENCIES.has(c), 'unknown currency'),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
});

export type SettingsInput = z.input<typeof settingsSchema>;

type Row = {
  tenant_name: string;
  default_locale: string;
  timezone: string;
  default_currency: string;
  country_code: string;
};

const toSettings = (r: Row): TenantSettings => ({
  tenantName: r.tenant_name,
  defaultLocale: r.default_locale,
  timezone: r.timezone,
  defaultCurrency: r.default_currency,
  countryCode: r.country_code,
});

const SELECT_SETTINGS = `SELECT t.display_name AS tenant_name, s.default_locale, s.timezone,
         s.default_currency, s.country_code
  FROM tenant_settings s JOIN tenants t ON t.id = s.tenant_id`;
const SELECT_SETTINGS_FOR_UPDATE = `${SELECT_SETTINGS} FOR UPDATE OF s`;

async function read(ctx: TenantContext, lock: boolean): Promise<Row> {
  const { rows } = await ctx.db.query<Row>(lock ? SELECT_SETTINGS_FOR_UPDATE : SELECT_SETTINGS);
  const row = rows[0];
  if (!row) throw new ConflictError('conflict');
  return row;
}

export async function getTenantSettings(ctx: TenantContext): Promise<TenantSettings> {
  await ctx.requirePermission('settings.read');
  return toSettings(await read(ctx, false));
}

/** Countries the platform has a jurisdiction profile for (rule 25). */
export async function availableCountries(ctx: TenantContext): Promise<string[]> {
  const { rows } = await ctx.db.query<{ country_code: string }>(
    'SELECT country_code FROM jurisdiction_profiles ORDER BY country_code',
  );
  return rows.map((r) => r.country_code);
}

export async function updateTenantSettings(
  ctx: TenantContext,
  input: SettingsInput,
): Promise<TenantSettings> {
  await ctx.requirePermission('settings.manage');
  const next = settingsSchema.parse(input);
  if (!(await availableCountries(ctx)).includes(next.countryCode)) {
    throw new InvalidRequestError();
  }
  const before = await read(ctx, true);
  const after: Row = {
    ...before,
    default_locale: next.defaultLocale,
    timezone: next.timezone,
    default_currency: next.defaultCurrency,
    country_code: next.countryCode,
  };
  const changed = (
    ['default_locale', 'timezone', 'default_currency', 'country_code'] as const
  ).filter((k) => before[k] !== after[k]);
  if (changed.length === 0) return toSettings(before);

  await ctx.db.query(
    `UPDATE tenant_settings SET default_locale = $1, timezone = $2, default_currency = $3,
            country_code = $4, updated_by = $5`,
    [after.default_locale, after.timezone, after.default_currency, after.country_code, ctx.userId],
  );
  const pick = (r: Row) => Object.fromEntries(changed.map((k) => [k, r[k]]));
  await ctx.audit({
    action: 'tenant_settings.updated',
    entityType: 'tenant_settings',
    entityId: ctx.tenantId,
    before: pick(before),
    after: pick(after),
  });
  await emitEvent(ctx.db, {
    eventType: 'tenant_settings.updated',
    aggregateType: 'tenant_settings',
    aggregateId: ctx.tenantId,
    payload: { changed },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return toSettings(after);
}
