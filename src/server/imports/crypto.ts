import { hkdfSync } from 'node:crypto';
import { openText, sealText } from '@/server/crypto/envelope';
import type { MasterKeyring } from '@/server/crypto/keyring';
import type { Grid } from './xlsx';

// import_runs.payload_enc (task 2.2): the uploaded rows as JSON, sealed with a per-tenant key
// derived from the master keyring (HKDF-SHA256, info "import_runs") — the same scheme as
// mail_outbox (ADR 0004). Short-lived: the column is cleared when the run ends (DB CHECK).

function importKey(keyring: MasterKeyring, tenantId: string, version: number): Buffer {
  return Buffer.from(
    hkdfSync('sha256', keyring.byVersion(version).key, tenantId, 'import_runs', 32),
  );
}

const aad = (tenantId: string, runId: string, version: number) =>
  `import_runs|${tenantId}|payload_enc|${runId}|${version}`;

export function sealGrid(
  keyring: MasterKeyring,
  tenantId: string,
  runId: string,
  grid: Grid,
): { ciphertext: Buffer; keyVersion: number } {
  const version = keyring.current.version;
  return {
    ciphertext: sealText(
      importKey(keyring, tenantId, version),
      JSON.stringify(grid),
      aad(tenantId, runId, version),
    ),
    keyVersion: version,
  };
}

export function openGrid(
  keyring: MasterKeyring,
  tenantId: string,
  runId: string,
  value: { ciphertext: Buffer; keyVersion: number },
): Grid {
  const json = openText(
    importKey(keyring, tenantId, value.keyVersion),
    value.ciphertext,
    aad(tenantId, runId, value.keyVersion),
  );
  return JSON.parse(json) as Grid;
}
