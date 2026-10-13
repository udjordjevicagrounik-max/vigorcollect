import { hkdfSync } from 'node:crypto';
import { openText, sealText } from '@/server/crypto/envelope';
import type { MasterKeyring } from '@/server/crypto/keyring';

// Integration secrets and inbound payloads (task 4.1, rule 9): encrypted with a key derived per
// tenant from the master keyring (HKDF-SHA256, info = the table), like mail_outbox (ADR 0003).
// The AAD binds a ciphertext to its tenant, table, column and row.

type Target =
  | 'integration_credentials.secret'
  | 'webhook_events.body'
  | 'mail_inbox.from'
  | 'mail_inbox.subject'
  | 'mail_inbox.body';

function key(keyring: MasterKeyring, tenantId: string, target: Target, version: number): Buffer {
  const table = target.split('.')[0] ?? target;
  return Buffer.from(hkdfSync('sha256', keyring.byVersion(version).key, tenantId, table, 32));
}

const aad = (tenantId: string, target: Target, rowId: string, version: number) =>
  `${target}|${tenantId}|${rowId}|${version}`;

export function seal(
  keyring: MasterKeyring,
  tenantId: string,
  target: Target,
  rowId: string,
  plaintext: string,
): { ciphertext: Buffer; keyVersion: number } {
  const version = keyring.current.version;
  return {
    ciphertext: sealText(
      key(keyring, tenantId, target, version),
      plaintext,
      aad(tenantId, target, rowId, version),
    ),
    keyVersion: version,
  };
}

export function open(
  keyring: MasterKeyring,
  tenantId: string,
  target: Target,
  rowId: string,
  value: { ciphertext: Buffer; keyVersion: number },
): string {
  return openText(
    key(keyring, tenantId, target, value.keyVersion),
    value.ciphertext,
    aad(tenantId, target, rowId, value.keyVersion),
  );
}
