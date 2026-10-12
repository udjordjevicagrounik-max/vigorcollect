import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM envelope (ADR 0003). Layout: [format 0x01][iv 12][tag 16][ciphertext].
// The AAD binds a ciphertext to its place (tenant, table.column, row, key version), so a value
// copied into another row, column or tenant fails to decrypt instead of silently moving.

const FORMAT_V1 = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export class DecryptionError extends Error {
  override name = 'DecryptionError';
}

export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_V1]), iv, cipher.getAuthTag(), body]);
}

export function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < HEADER_BYTES || sealed[0] !== FORMAT_V1) {
    throw new DecryptionError('unsupported ciphertext format');
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]);
  } catch {
    // No detail: the reason (wrong key, tampering, wrong AAD) must not leak to callers.
    throw new DecryptionError('ciphertext could not be authenticated');
  }
}

export function sealText(key: Buffer, plaintext: string, aad: string): Buffer {
  return seal(key, Buffer.from(plaintext, 'utf8'), aad);
}

export function openText(key: Buffer, sealed: Buffer, aad: string): string {
  return open(key, sealed, aad).toString('utf8');
}
