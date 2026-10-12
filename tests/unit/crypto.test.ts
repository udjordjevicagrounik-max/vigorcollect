import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blindIndex, normalizeEmail } from '@/server/crypto/blind-index';
import { DecryptionError, openText, sealText } from '@/server/crypto/envelope';
import { KeyringError, parseMasterKeyring } from '@/server/crypto/keyring';

const key = () => randomBytes(32);
const b64 = (buf: Buffer) => buf.toString('base64');

describe('crypto envelope (AES-256-GCM)', () => {
  it('round-trips and never contains the plaintext', () => {
    const k = key();
    const sealed = sealText(k, 'ana@example.test', 'aad');
    expect(sealed.includes(Buffer.from('ana@example.test'))).toBe(false);
    expect(openText(k, sealed, 'aad')).toBe('ana@example.test');
  });

  it('same plaintext twice gives different ciphertexts (random IV)', () => {
    const k = key();
    expect(sealText(k, 'x', 'aad').equals(sealText(k, 'x', 'aad'))).toBe(false);
  });

  it('wrong key, wrong AAD or a flipped bit fails with DecryptionError', () => {
    const k = key();
    const sealed = sealText(k, 'secret', 'tenant-a|row-1');
    expect(() => openText(key(), sealed, 'tenant-a|row-1')).toThrow(DecryptionError);
    expect(() => openText(k, sealed, 'tenant-b|row-1')).toThrow(DecryptionError);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => openText(k, tampered, 'tenant-a|row-1')).toThrow(DecryptionError);
  });
});

describe('blind index', () => {
  it('normalizes e-mail before hashing', () => {
    const k = key();
    expect(normalizeEmail('  Ana@Example.TEST ')).toBe('ana@example.test');
    expect(blindIndex(k, 'f', normalizeEmail('Ana@Example.test'))).toEqual(
      blindIndex(k, 'f', normalizeEmail('ana@example.test')),
    );
  });

  it('different tenant keys or fields give different indexes (rule 33)', () => {
    const value = 'ana@example.test';
    const [ka, kb] = [key(), key()];
    expect(blindIndex(ka, 'f', value).equals(blindIndex(kb, 'f', value))).toBe(false);
    expect(blindIndex(ka, 'f', value).equals(blindIndex(ka, 'g', value))).toBe(false);
    expect(blindIndex(ka, 'f', value)).toHaveLength(32);
  });
});

describe('master keyring', () => {
  it('uses the highest version as current and keeps older versions readable', () => {
    const [k1, k2] = [key(), key()];
    const ring = parseMasterKeyring(`1:${b64(k1)},2:${b64(k2)}`);
    expect(ring.current.version).toBe(2);
    expect(ring.byVersion(1).key.equals(k1)).toBe(true);
  });

  it('rejects missing, malformed, short and duplicate keys without echoing key material', () => {
    const secret = b64(key());
    expect(() => parseMasterKeyring(undefined)).toThrow(KeyringError);
    expect(() => parseMasterKeyring(secret)).toThrow(KeyringError);
    expect(() => parseMasterKeyring(`1:${b64(randomBytes(16))}`)).toThrow(KeyringError);
    expect(() => parseMasterKeyring(`1:${secret},1:${secret}`)).toThrow(KeyringError);
    try {
      parseMasterKeyring(`1:${secret},1:${secret}`);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
    expect(() => parseMasterKeyring(`1:${secret}`).byVersion(9)).toThrow(KeyringError);
  });
});
