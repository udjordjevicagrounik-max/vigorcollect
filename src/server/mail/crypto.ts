import { hkdfSync } from 'node:crypto';
import { openText, sealText } from '@/server/crypto/envelope';
import type { MasterKeyring } from '@/server/crypto/keyring';

// mail_outbox encryption (ADR 0004, decision 1.1b): the key is derived per tenant from the
// master keyring (HKDF-SHA256, info "mail_outbox"), so no key material is stored and the
// *_key_version column is the master key version. The AAD binds a ciphertext to its tenant,
// column and row (ADR 0003 envelope). Subject keys (subject_keys) stay reserved for data
// subjects; outbox rows are short-lived (retention 7 days) and need no crypto-shredding.

export type MailColumn = 'recipient' | 'body';

function mailKey(keyring: MasterKeyring, tenantId: string, version: number): Buffer {
  const master = keyring.byVersion(version);
  return Buffer.from(hkdfSync('sha256', master.key, tenantId, 'mail_outbox', 32));
}

function aad(tenantId: string, column: MailColumn, rowId: string, version: number): string {
  return `mail_outbox|${tenantId}|${column}_enc|${rowId}|${version}`;
}

export function sealMail(
  keyring: MasterKeyring,
  tenantId: string,
  column: MailColumn,
  rowId: string,
  plaintext: string,
): { ciphertext: Buffer; keyVersion: number } {
  const version = keyring.current.version;
  return {
    ciphertext: sealText(
      mailKey(keyring, tenantId, version),
      plaintext,
      aad(tenantId, column, rowId, version),
    ),
    keyVersion: version,
  };
}

export function openMail(
  keyring: MasterKeyring,
  tenantId: string,
  column: MailColumn,
  rowId: string,
  value: { ciphertext: Buffer; keyVersion: number },
): string {
  return openText(
    mailKey(keyring, tenantId, value.keyVersion),
    value.ciphertext,
    aad(tenantId, column, rowId, value.keyVersion),
  );
}
