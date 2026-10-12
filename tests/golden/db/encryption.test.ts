import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DecryptionError } from '@/server/crypto/envelope';
import { parseMasterKeyring } from '@/server/crypto/keyring';
import {
  createContact,
  createCustomer,
  findContactIdsByEmail,
  readContact,
  readCustomerName,
} from '@/server/customers/repository';
import { ensureFixtures, FX } from './fixtures';
import { appPool, closePools, inTenant, sqlState } from './helpers';

// Golden (never delete or skip): P1/P2 are stored only encrypted, with key_version, and the
// e-mail blind index is keyed per tenant (rules 20, 33; ADR 0003). Everything runs as vigor_app
// in rolled-back transactions; the master key is generated per run and never stored.

const keyring = parseMasterKeyring(`1:${randomBytes(32).toString('base64')}`);
const EMAIL = 'Ana.Kontakt@Golden.Example.Test';
const NAME = 'Ana Kontakt';
const PHONE = '+381 11 000 0000';

beforeAll(ensureFixtures);
afterAll(closePools);

function containsText(value: Buffer | null, text: string): boolean {
  return value !== null && value.includes(Buffer.from(text, 'utf8'));
}

describe('golden/db: customer_contacts are encrypted at rest', () => {
  it('raw row holds no plaintext; every encrypted field has key_version 1', async () => {
    const raw = await inTenant(appPool, FX.tenantA, async (c) => {
      const id = await createContact(c, keyring, {
        customerId: FX.customerA,
        name: NAME,
        email: EMAIL,
        phone: PHONE,
      });
      const { rows } = await c.query('SELECT * FROM customer_contacts WHERE id = $1', [id]);
      return rows[0] as Record<string, unknown>;
    });
    const text = JSON.stringify(raw);
    for (const plain of [NAME, EMAIL, EMAIL.toLowerCase(), PHONE]) {
      expect(text).not.toContain(plain);
      for (const col of ['name_enc', 'email_enc', 'phone_enc', 'email_bidx']) {
        expect(containsText(raw[col] as Buffer | null, plain)).toBe(false);
      }
    }
    expect(raw).toMatchObject({
      name_key_version: 1,
      email_key_version: 1,
      phone_key_version: 1,
      email_bidx_key_version: 1,
    });
  });

  it('round-trips through the repository and creates one data key per contact', async () => {
    const result = await inTenant(appPool, FX.tenantA, async (c) => {
      const id = await createContact(c, keyring, {
        customerId: FX.customerA,
        name: NAME,
        email: EMAIL,
      });
      const keys = await c.query(
        `SELECT purpose, key_version FROM subject_keys
         WHERE subject_type = 'customer_contact' AND subject_id = $1`,
        [id],
      );
      return { contact: await readContact(c, keyring, id), keys: keys.rows };
    });
    expect(result.contact).toMatchObject({ name: NAME, email: EMAIL, phone: null });
    expect(result.keys).toEqual([{ purpose: 'data', key_version: 1 }]);
  });

  it('a ciphertext copied into another row does not decrypt (AAD binds row and column)', async () => {
    const error = await inTenant(appPool, FX.tenantA, async (c) => {
      const one = await createContact(c, keyring, { customerId: FX.customerA, name: 'One' });
      const two = await createContact(c, keyring, { customerId: FX.customerA, name: 'Two' });
      await c.query(
        `UPDATE customer_contacts SET name_enc = (SELECT name_enc FROM customer_contacts WHERE id = $1)
         WHERE id = $2`,
        [one, two],
      );
      return readContact(c, keyring, two).then(
        () => null,
        (e: unknown) => e,
      );
    });
    expect(error).toBeInstanceOf(DecryptionError);
  });
});

describe('golden/db: natural-person customers', () => {
  it('display name is stored only encrypted and decrypts through the repository', async () => {
    const res = await inTenant(appPool, FX.tenantA, async (c) => {
      const { id } = await createCustomer(c, keyring, {
        countryCode: 'XX',
        taxId: 'GOLDEN-PERSON',
        legalName: 'Golden Sole Trader',
        timezone: 'UTC',
        isNaturalPerson: true,
        displayName: 'Petar Fizičko',
      });
      const { rows } = await c.query<{ display_name: string | null; display_name_enc: Buffer }>(
        'SELECT display_name, display_name_enc FROM customers WHERE id = $1',
        [id],
      );
      return { row: rows[0], name: await readCustomerName(c, keyring, id) };
    });
    expect(res.row?.display_name).toBeNull();
    expect(containsText(res.row?.display_name_enc ?? null, 'Petar')).toBe(false);
    expect(res.name).toBe('Petar Fizičko');
  });
});

describe('golden/db: blind index is per tenant (rule 33)', () => {
  async function bidxIn(tenantId: string, customerId: string): Promise<Buffer> {
    return inTenant(appPool, tenantId, async (c) => {
      const id = await createContact(c, keyring, { customerId, name: NAME, email: EMAIL });
      const { rows } = await c.query<{ email_bidx: Buffer }>(
        'SELECT email_bidx FROM customer_contacts WHERE id = $1',
        [id],
      );
      return rows[0]?.email_bidx ?? Buffer.alloc(0);
    });
  }

  it('the same e-mail in tenant A and tenant B gives different indexes', async () => {
    const a = await bidxIn(FX.tenantA, FX.customerA);
    const b = await bidxIn(FX.tenantB, FX.customerB);
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });

  it('exact lookup finds the contact in its own tenant (case-insensitive) and nothing elsewhere', async () => {
    const found = await inTenant(appPool, FX.tenantA, async (c) => {
      const id = await createContact(c, keyring, {
        customerId: FX.customerA,
        name: NAME,
        email: EMAIL,
      });
      return { id, hits: await findContactIdsByEmail(c, keyring, EMAIL.toUpperCase()) };
    });
    expect(found.hits).toEqual([found.id]);

    const elsewhere = await inTenant(appPool, FX.tenantB, (c) =>
      findContactIdsByEmail(c, keyring, EMAIL),
    );
    expect(elsewhere).toEqual([]);
  });

  it('a lookup never creates key material', async () => {
    const keys = await inTenant(appPool, FX.tenantB, async (c) => {
      await findContactIdsByEmail(c, keyring, EMAIL);
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM subject_keys');
      return rows[0]?.n;
    });
    expect(keys).toBe(0);
  });
});

describe('golden/db: subject_keys', () => {
  it('the app cannot update or delete keys (rotation/erasure is a separate job)', async () => {
    const update = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(c.query(`UPDATE subject_keys SET status = 'retired'`)),
    );
    const del = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(c.query('DELETE FROM subject_keys')),
    );
    expect(update).toBe('42501');
    expect(del).toBe('42501');
  });

  it('a blind index key can only belong to the tenant itself', async () => {
    const state = await inTenant(appPool, FX.tenantA, (c) =>
      sqlState(
        c.query(
          `INSERT INTO subject_keys (tenant_id, subject_type, subject_id, purpose, key_version,
                                     master_key_version, wrapped_key)
           VALUES ($1, 'tenant', $2, 'blind_index', 1, 1, '\\x01')`,
          [FX.tenantA, FX.tenantB],
        ),
      ),
    );
    expect(state).toBe('23514');
  });
});
