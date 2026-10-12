import { z } from 'zod';

// Master keys (KEK) for wrapping per-subject data keys (ADR 0003). They live ONLY in the
// environment / vault — never in the database, a backup, a log or a commit (rules 9, 28).
//
// PII_MASTER_KEYS="1:<base64 32 bytes>[,2:<base64 32 bytes>...]"
// The highest version wraps new keys; older versions stay until the re-encrypt job has
// re-wrapped everything (rotation, ADR 0003).

const KEY_BYTES = 32;

export type MasterKey = { version: number; key: Buffer };

export type MasterKeyring = {
  current: MasterKey;
  byVersion(version: number): MasterKey;
};

const entrySchema = z
  .string()
  .regex(/^[1-9][0-9]{0,5}:[A-Za-z0-9+/]+={0,2}$/, 'expected "<version>:<base64>"');

export class KeyringError extends Error {
  override name = 'KeyringError';
}

/** Parses PII_MASTER_KEYS. Error messages never contain key material. */
export function parseMasterKeyring(value: string | undefined): MasterKeyring {
  if (!value) throw new KeyringError('PII_MASTER_KEYS is not set.');

  const keys = new Map<number, MasterKey>();
  for (const raw of value.split(',')) {
    const parsed = entrySchema.safeParse(raw.trim());
    if (!parsed.success) throw new KeyringError('PII_MASTER_KEYS: malformed entry.');
    const [versionText = '', base64 = ''] = parsed.data.split(':');
    const version = Number(versionText);
    const key = Buffer.from(base64, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new KeyringError(`PII_MASTER_KEYS: key version ${version} is not ${KEY_BYTES} bytes.`);
    }
    if (keys.has(version)) throw new KeyringError(`PII_MASTER_KEYS: duplicate version ${version}.`);
    keys.set(version, { version, key });
  }

  const currentVersion = Math.max(...keys.keys());
  const current = keys.get(currentVersion);
  if (!current) throw new KeyringError('PII_MASTER_KEYS: no keys.');

  return {
    current,
    byVersion(version) {
      const found = keys.get(version);
      if (!found)
        throw new KeyringError(`PII_MASTER_KEYS: master key version ${version} is missing.`);
      return found;
    },
  };
}

let cached: MasterKeyring | undefined;

/** Keyring from process.env, parsed once per process. */
export function getMasterKeyring(): MasterKeyring {
  cached ??= parseMasterKeyring(process.env.PII_MASTER_KEYS);
  return cached;
}
