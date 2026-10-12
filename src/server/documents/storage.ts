import { hkdfSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { open as openSealed, seal } from '@/server/crypto/envelope';
import type { MasterKeyring } from '@/server/crypto/keyring';

/**
 * Document storage adapter (task 3.2). Dev: local disk under DOCUMENTS_DIR (default
 * <cwd>/data/documents — in the dev container: <repo>/data/documents); S3 later
 * behind the same interface. Content is sealed with a per-tenant key derived from the master
 * keyring (HKDF, info "documents"), bound to tenant + document id (AAD). A storage_ref is never
 * a URL: files leave only through exportService (rule 12).
 */

export type StoredObject = { storageRef: string; keyVersion: number };

function root(): string {
  return process.env.DOCUMENTS_DIR || join(process.cwd(), 'data', 'documents');
}

function key(keyring: MasterKeyring, tenantId: string, version: number): Buffer {
  return Buffer.from(hkdfSync('sha256', keyring.byVersion(version).key, tenantId, 'documents', 32));
}

const aad = (tenantId: string, documentId: string, version: number) =>
  `documents|${tenantId}|${documentId}|${version}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pathFor(tenantId: string, documentId: string): { ref: string; file: string } {
  if (!UUID.test(tenantId) || !UUID.test(documentId)) throw new Error('storage: invalid id');
  const rel = `${tenantId}/${documentId}.bin`;
  return { ref: `local:${rel}`, file: join(root(), rel) };
}

export function putDocument(
  keyring: MasterKeyring,
  tenantId: string,
  documentId: string,
  content: Buffer,
): StoredObject {
  const version = keyring.current.version;
  const { ref, file } = pathFor(tenantId, documentId);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(
    file,
    seal(key(keyring, tenantId, version), content, aad(tenantId, documentId, version)),
    { mode: 0o600 },
  );
  return { storageRef: ref, keyVersion: version };
}

export function getDocument(
  keyring: MasterKeyring,
  tenantId: string,
  documentId: string,
  stored: StoredObject,
): Buffer {
  const { ref, file } = pathFor(tenantId, documentId);
  if (stored.storageRef !== ref) throw new Error('storage: reference does not match the document');
  return openSealed(
    key(keyring, tenantId, stored.keyVersion),
    readFileSync(file),
    aad(tenantId, documentId, stored.keyVersion),
  );
}
