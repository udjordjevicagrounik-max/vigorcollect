/**
 * PII scrubbing for anything that leaves the system for monitoring (Sentry, alarms) — rule 20.
 * Two layers:
 *   1. KEYS: a value under a sensitive key is replaced. Sensitive = a fixed base list PLUS every
 *      column pii_field_registry classifies above P0 (or conditionally) — loaded at start;
 *   2. VALUES: inside any remaining string, e-mail addresses, long digit runs (PIB 9, MB 8,
 *      JMBG 13) and IBANs are masked.
 * Our own errors carry codes, not values; this is the safety net, not the plan.
 */

export const REDACTED = '[redacted]';

export const BASE_SENSITIVE_KEYS = [
  'email',
  'name',
  'display_name',
  'displayname',
  'legal_name',
  'normalized_name',
  'tax_id',
  'taxid',
  'pib',
  'jmbg',
  'registration_number',
  'phone',
  'address',
  'address_line1',
  'address_line2',
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
  'x-captcha-response',
  'totp',
  'backup_codes',
  'iban',
  'ip_address',
  'username',
] as const;

const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;
const LONG_DIGITS = /\b\d{8,13}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
// UUIDs are ids (P0) and must survive the digit rule: scrub only the text between them.
const UUID = /(\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/i;

export function scrubText(text: string): string {
  return text
    .split(UUID)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(EMAIL, '[email]').replace(IBAN, '[iban]').replace(LONG_DIGITS, '[number]'),
    )
    .join('');
}

export function sensitiveKeySet(extra: Iterable<string> = []): Set<string> {
  return new Set([...BASE_SENSITIVE_KEYS, ...extra].map((k) => k.toLowerCase()));
}

function isSensitive(key: string, keys: Set<string>): boolean {
  const k = key.toLowerCase();
  return keys.has(k) || k.endsWith('_enc') || k.endsWith('_bidx');
}

export function scrubDeep(value: unknown, keys: Set<string>, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, keys, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        isSensitive(k, keys) ? REDACTED : scrubDeep(v, keys, depth + 1),
      ]),
    );
  }
  return value;
}

type SentryLikeEvent = Record<string, unknown> & {
  user?: unknown;
  request?: { headers?: Record<string, string>; cookies?: unknown; data?: unknown } & Record<
    string,
    unknown
  >;
};

/** Sentry beforeSend: no user, no cookies, only the correlation header, everything scrubbed. */
export function scrubEvent<E extends SentryLikeEvent>(event: E, keys: Set<string>): E {
  const copy = { ...event };
  delete copy.user;
  if (copy.request) {
    const requestId = copy.request.headers?.['x-request-id'];
    copy.request = {
      ...copy.request,
      cookies: undefined,
      data: undefined,
      headers: requestId ? { 'x-request-id': requestId } : {},
    };
  }
  return scrubDeep(copy, keys) as E;
}
