import { createHmac } from 'node:crypto';

// Blind index (ADR 0003): HMAC-SHA256 with the TENANT's own blind index key — never a global
// key, so the same e-mail in two tenants yields unrelated indexes and nothing can be joined
// across tenants (rule 33). The field name is part of the input (domain separation).

export function normalizeEmail(email: string): string {
  return email.normalize('NFC').trim().toLowerCase();
}

export function blindIndex(tenantKey: Buffer, field: string, normalizedValue: string): Buffer {
  return createHmac('sha256', tenantKey)
    .update(`${field}\u0000${normalizedValue}`, 'utf8')
    .digest();
}
