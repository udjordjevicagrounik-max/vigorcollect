import { randomBytes } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { open, openText, seal, sealText } from './envelope';
import { blindIndex, normalizeEmail } from './blind-index';
import type { MasterKeyring } from './keyring';

// Per-subject data keys and the per-tenant blind index key (ADR 0003).
// Every function runs inside a tenant transaction (SET LOCAL app.tenant_id, rule 2): the
// tenant is read from the session via app_tenant_id(), never passed in by the caller.

/** pg Client / PoolClient — already inside a tenant transaction. */
export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
};

export type SubjectType = 'customer' | 'customer_contact';

export type SubjectRef = { type: SubjectType; id: string };

/** Physical location of an encrypted value — part of the AAD. */
export type FieldRef = { table: string; column: string; rowId: string };

export type Encrypted = { ciphertext: Buffer; keyVersion: number };

export class SubjectKeyError extends Error {
  override name = 'SubjectKeyError';
}

type KeyPurpose = 'data' | 'blind_index';
type KeyRef = { subjectType: SubjectType | 'tenant'; subjectId: string; purpose: KeyPurpose };
type KeyRow = { key_version: number; master_key_version: number; wrapped_key: Buffer | null };
type DataKey = { version: number; key: Buffer };

const DATA_KEY_BYTES = 32;

export async function currentTenantId(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ id: string | null }>('SELECT app_tenant_id() AS id');
  const id = rows[0]?.id;
  if (!id) throw new SubjectKeyError('no tenant context (withTenant / SET LOCAL app.tenant_id)');
  return id;
}

function wrapAad(tenantId: string, ref: KeyRef, version: number): string {
  return `subject_key|${tenantId}|${ref.subjectType}|${ref.subjectId}|${ref.purpose}|${version}`;
}

function fieldAad(tenantId: string, field: FieldRef, keyVersion: number): string {
  return `field|${tenantId}|${field.table}.${field.column}|${field.rowId}|${keyVersion}`;
}

function unwrap(keyring: MasterKeyring, tenantId: string, ref: KeyRef, row: KeyRow): DataKey {
  if (!row.wrapped_key) throw new SubjectKeyError('subject key destroyed (crypto-shredded)');
  const master = keyring.byVersion(row.master_key_version);
  const key = open(master.key, row.wrapped_key, wrapAad(tenantId, ref, row.key_version));
  return { version: row.key_version, key };
}

async function selectActive(db: Queryable, ref: KeyRef): Promise<KeyRow | undefined> {
  const { rows } = await db.query<KeyRow>(
    `SELECT key_version, master_key_version, wrapped_key FROM subject_keys
     WHERE subject_type = $1 AND subject_id = $2 AND purpose = $3 AND status = 'active'`,
    [ref.subjectType, ref.subjectId, ref.purpose],
  );
  return rows[0];
}

/** Active key of a subject; created (version = last + 1) when the subject has none. */
async function activeKey(db: Queryable, keyring: MasterKeyring, ref: KeyRef): Promise<DataKey> {
  const key = await findOrCreateActiveKey(db, keyring, ref, true);
  if (!key) throw new SubjectKeyError('subject key could not be created');
  return key;
}

async function findOrCreateActiveKey(
  db: Queryable,
  keyring: MasterKeyring,
  ref: KeyRef,
  create: boolean,
): Promise<DataKey | undefined> {
  const tenantId = await currentTenantId(db);
  let row = await selectActive(db, ref);
  if (!row && create) {
    const { rows } = await db.query<{ next: number }>(
      `SELECT coalesce(max(key_version), 0) + 1 AS next FROM subject_keys
       WHERE subject_type = $1 AND subject_id = $2 AND purpose = $3`,
      [ref.subjectType, ref.subjectId, ref.purpose],
    );
    const version = rows[0]?.next ?? 1;
    const wrapped = seal(
      keyring.current.key,
      randomBytes(DATA_KEY_BYTES),
      wrapAad(tenantId, ref, version),
    );
    // A concurrent creator wins on the unique indexes; we then read its key.
    await db.query(
      `INSERT INTO subject_keys
         (tenant_id, subject_type, subject_id, purpose, key_version, master_key_version, wrapped_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [
        tenantId,
        ref.subjectType,
        ref.subjectId,
        ref.purpose,
        version,
        keyring.current.version,
        wrapped,
      ],
    );
    row = await selectActive(db, ref);
  }
  return row ? unwrap(keyring, tenantId, ref, row) : undefined;
}

async function keyByVersion(
  db: Queryable,
  keyring: MasterKeyring,
  ref: KeyRef,
  version: number,
): Promise<DataKey> {
  const tenantId = await currentTenantId(db);
  const { rows } = await db.query<KeyRow>(
    `SELECT key_version, master_key_version, wrapped_key FROM subject_keys
     WHERE subject_type = $1 AND subject_id = $2 AND purpose = $3 AND key_version = $4`,
    [ref.subjectType, ref.subjectId, ref.purpose, version],
  );
  const row = rows[0];
  if (!row) throw new SubjectKeyError(`subject key version ${version} not found`);
  return unwrap(keyring, tenantId, ref, row);
}

function dataRef(subject: SubjectRef): KeyRef {
  return { subjectType: subject.type, subjectId: subject.id, purpose: 'data' };
}

export async function encryptField(
  db: Queryable,
  keyring: MasterKeyring,
  subject: SubjectRef,
  field: FieldRef,
  plaintext: string,
): Promise<Encrypted> {
  const tenantId = await currentTenantId(db);
  const key = await activeKey(db, keyring, dataRef(subject));
  return {
    ciphertext: sealText(key.key, plaintext, fieldAad(tenantId, field, key.version)),
    keyVersion: key.version,
  };
}

export async function decryptField(
  db: Queryable,
  keyring: MasterKeyring,
  subject: SubjectRef,
  field: FieldRef,
  value: Encrypted,
): Promise<string> {
  const tenantId = await currentTenantId(db);
  const key = await keyByVersion(db, keyring, dataRef(subject), value.keyVersion);
  return openText(key.key, value.ciphertext, fieldAad(tenantId, field, value.keyVersion));
}

export type BlindIndex = { bidx: Buffer; keyVersion: number };

/**
 * E-mail blind index with the CURRENT tenant's key (rule 33: never a global key).
 * `createKey: false` (lookups) returns undefined when the tenant has no key yet — a search
 * never creates key material.
 */
export async function emailBlindIndex(
  db: Queryable,
  keyring: MasterKeyring,
  field: string,
  email: string,
  options: { createKey: boolean },
): Promise<BlindIndex | undefined> {
  const tenantId = await currentTenantId(db);
  const ref: KeyRef = { subjectType: 'tenant', subjectId: tenantId, purpose: 'blind_index' };
  const key = await findOrCreateActiveKey(db, keyring, ref, options.createKey);
  if (!key) return undefined;
  return { bidx: blindIndex(key.key, field, normalizeEmail(email)), keyVersion: key.version };
}
