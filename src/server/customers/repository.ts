import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MasterKeyring } from '@/server/crypto/keyring';
import {
  decryptField,
  emailBlindIndex,
  encryptField,
  type Queryable,
} from '@/server/crypto/subject-keys';

// Data access for customers and their contacts (rule 30, ADR 0003). Runs inside a tenant
// transaction; tenant_id comes from the session (app_tenant_id()), never from the caller.
// Services on top of this (task 1.x) add requirePermission, audit() and domain_events.

const localeSchema = z.string().regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/);

export const newCustomerSchema = z.object({
  // Optional fixed id — deterministic seed only (rule 24); otherwise generated.
  id: z.uuid().optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  taxId: z.string().trim().min(1),
  registrationNumber: z.string().trim().min(1).optional(),
  legalName: z.string().trim().min(1),
  timezone: z.string().min(1),
  isNaturalPerson: z.boolean(),
  displayName: z.string().trim().min(1),
  relationshipType: z.enum(['customer', 'supplier', 'both']).default('customer'),
  externalId: z.string().trim().min(1).optional(),
  ownerUserId: z.uuid().optional(),
  language: localeSchema.optional(),
});

export type NewCustomer = z.input<typeof newCustomerSchema>;

// Consumer = natural person without business registration (ADR 0002, decision 4): never a
// canonical identity, never find_or_create_legal_entity; identity exists only encrypted here.
export const newConsumerSchema = z.object({
  id: z.uuid().optional(),
  displayName: z.string().trim().min(1),
  relationshipType: z.enum(['customer', 'supplier', 'both']).default('customer'),
  externalId: z.string().trim().min(1).optional(),
  ownerUserId: z.uuid().optional(),
  language: localeSchema.optional(),
});

export type NewConsumer = z.input<typeof newConsumerSchema>;

export const newContactSchema = z.object({
  id: z.uuid().optional(),
  customerId: z.uuid(),
  name: z.string().trim().min(1),
  email: z.email().optional(),
  phone: z.string().trim().min(3).optional(),
  isPrimary: z.boolean().default(false),
  language: localeSchema.optional(),
});

export type NewContact = z.input<typeof newContactSchema>;

export type Contact = {
  id: string;
  customerId: string;
  name: string;
  email: string | null;
  phone: string | null;
};

const CONTACT_EMAIL_BIDX = 'customer_contacts.email';

/** Links the tenant to the canonical legal entity (exact match) and creates the customer. */
export async function createCustomer(
  db: Queryable,
  keyring: MasterKeyring,
  input: NewCustomer,
): Promise<{ id: string; legalEntityId: string }> {
  const c = newCustomerSchema.parse(input);
  const { rows } = await db.query<{ id: string }>(
    'SELECT find_or_create_legal_entity($1, $2, $3, $4, $5) AS id',
    [c.countryCode, c.taxId, c.legalName, c.timezone, c.registrationNumber ?? null],
  );
  const legalEntityId = rows[0]?.id;
  if (!legalEntityId) throw new Error('find_or_create_legal_entity returned no id');

  const id = c.id ?? randomUUID();
  // Rule 20: a natural person's name is stored only encrypted (CHECK customers_name_protection).
  const name = c.isNaturalPerson
    ? await encryptField(
        db,
        keyring,
        { type: 'customer', id },
        { table: 'customers', column: 'display_name_enc', rowId: id },
        c.displayName,
      )
    : null;

  await db.query(
    `INSERT INTO customers (id, tenant_id, legal_entity_id, relationship_type, is_natural_person,
                            display_name, display_name_enc, display_name_key_version,
                            external_id, owner_user_id, language)
     VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      legalEntityId,
      c.relationshipType,
      c.isNaturalPerson,
      name ? null : c.displayName,
      name?.ciphertext ?? null,
      name?.keyVersion ?? null,
      c.externalId ?? null,
      c.ownerUserId ?? null,
      c.language ?? null,
    ],
  );
  return { id, legalEntityId };
}

/** Creates a consumer: is_natural_person = true, legal_entity_id = NULL, name encrypted. */
export async function createConsumer(
  db: Queryable,
  keyring: MasterKeyring,
  input: NewConsumer,
): Promise<{ id: string }> {
  const c = newConsumerSchema.parse(input);
  const id = c.id ?? randomUUID();
  const name = await encryptField(
    db,
    keyring,
    { type: 'customer', id },
    { table: 'customers', column: 'display_name_enc', rowId: id },
    c.displayName,
  );
  await db.query(
    `INSERT INTO customers (id, tenant_id, legal_entity_id, relationship_type, is_natural_person,
                            display_name_enc, display_name_key_version, external_id,
                            owner_user_id, language)
     VALUES ($1, app_tenant_id(), NULL, $2, true, $3, $4, $5, $6, $7)`,
    [
      id,
      c.relationshipType,
      name.ciphertext,
      name.keyVersion,
      c.externalId ?? null,
      c.ownerUserId ?? null,
      c.language ?? null,
    ],
  );
  return { id };
}

/**
 * The tenant's customer for a canonical legal entity (country + tax id), created when missing —
 * import (2.2) "find_or_create po (country, tax_id)". Companies only: a natural person never gets
 * a canonical identity (ADR 0002, decision 4).
 */
export async function findOrCreateCompanyCustomer(
  db: Queryable,
  keyring: MasterKeyring,
  input: {
    countryCode: string;
    taxId: string;
    legalName: string;
    timezone: string;
    registrationNumber?: string | null;
    externalId?: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT find_or_create_legal_entity($1, $2, $3, $4, $5) AS id',
    [input.countryCode, input.taxId, input.legalName, input.timezone, input.registrationNumber ?? null],
  );
  const legalEntityId = rows[0]?.id;
  if (!legalEntityId) throw new Error('find_or_create_legal_entity returned no id');
  const existing = await db.query<{ id: string }>('SELECT id FROM customers WHERE legal_entity_id = $1', [
    legalEntityId,
  ]);
  const id = existing.rows[0]?.id;
  if (id) return { id, created: false };
  const created = await createCustomer(db, keyring, {
    countryCode: input.countryCode,
    taxId: input.taxId,
    registrationNumber: input.registrationNumber ?? undefined,
    legalName: input.legalName,
    timezone: input.timezone,
    isNaturalPerson: false,
    displayName: input.legalName,
    externalId: input.externalId ?? undefined,
  });
  return { id: created.id, created: true };
}

/** Display name of a customer, decrypted for natural persons. */
export async function readCustomerName(
  db: Queryable,
  keyring: MasterKeyring,
  customerId: string,
): Promise<string | undefined> {
  const { rows } = await db.query<{
    display_name: string | null;
    display_name_enc: Buffer | null;
    display_name_key_version: number | null;
  }>(
    'SELECT display_name, display_name_enc, display_name_key_version FROM customers WHERE id = $1',
    [customerId],
  );
  const row = rows[0];
  if (!row) return undefined;
  if (row.display_name !== null) return row.display_name;
  if (!row.display_name_enc || row.display_name_key_version === null) return undefined;
  return decryptField(
    db,
    keyring,
    { type: 'customer', id: customerId },
    { table: 'customers', column: 'display_name_enc', rowId: customerId },
    { ciphertext: row.display_name_enc, keyVersion: row.display_name_key_version },
  );
}

export async function createContact(
  db: Queryable,
  keyring: MasterKeyring,
  input: NewContact,
): Promise<string> {
  const c = newContactSchema.parse(input);
  const id = c.id ?? randomUUID();
  const subject = { type: 'customer_contact', id } as const;
  const at = (column: string) => ({ table: 'customer_contacts', column, rowId: id });

  const name = await encryptField(db, keyring, subject, at('name_enc'), c.name);
  const email = c.email ? await encryptField(db, keyring, subject, at('email_enc'), c.email) : null;
  const emailIdx = c.email
    ? await emailBlindIndex(db, keyring, CONTACT_EMAIL_BIDX, c.email, { createKey: true })
    : undefined;
  const phone = c.phone ? await encryptField(db, keyring, subject, at('phone_enc'), c.phone) : null;

  await db.query(
    `INSERT INTO customer_contacts (id, tenant_id, customer_id, name_enc, name_key_version,
                                    email_enc, email_key_version, email_bidx, email_bidx_key_version,
                                    phone_enc, phone_key_version, is_primary, language)
     VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      c.customerId,
      name.ciphertext,
      name.keyVersion,
      email?.ciphertext ?? null,
      email?.keyVersion ?? null,
      emailIdx?.bidx ?? null,
      emailIdx?.keyVersion ?? null,
      phone?.ciphertext ?? null,
      phone?.keyVersion ?? null,
      c.isPrimary,
      c.language ?? null,
    ],
  );
  return id;
}

/** Exact e-mail lookup through the tenant's blind index — never a scan, never LIKE. */
export async function findContactIdsByEmail(
  db: Queryable,
  keyring: MasterKeyring,
  email: string,
): Promise<string[]> {
  const idx = await emailBlindIndex(db, keyring, CONTACT_EMAIL_BIDX, email, { createKey: false });
  if (!idx) return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM customer_contacts
     WHERE email_bidx = $1 AND email_bidx_key_version = $2 ORDER BY id`,
    [idx.bidx, idx.keyVersion],
  );
  return rows.map((r) => r.id);
}

export async function readContact(
  db: Queryable,
  keyring: MasterKeyring,
  contactId: string,
): Promise<Contact | undefined> {
  const { rows } = await db.query<{
    customer_id: string;
    name_enc: Buffer;
    name_key_version: number;
    email_enc: Buffer | null;
    email_key_version: number | null;
    phone_enc: Buffer | null;
    phone_key_version: number | null;
  }>(
    `SELECT customer_id, name_enc, name_key_version, email_enc, email_key_version,
            phone_enc, phone_key_version
     FROM customer_contacts WHERE id = $1`,
    [contactId],
  );
  const row = rows[0];
  if (!row) return undefined;

  const subject = { type: 'customer_contact', id: contactId } as const;
  const at = (column: string) => ({ table: 'customer_contacts', column, rowId: contactId });
  const decrypt = (column: string, ciphertext: Buffer | null, keyVersion: number | null) =>
    ciphertext && keyVersion !== null
      ? decryptField(db, keyring, subject, at(column), { ciphertext, keyVersion })
      : Promise.resolve(null);

  return {
    id: contactId,
    customerId: row.customer_id,
    name: await decryptField(db, keyring, subject, at('name_enc'), {
      ciphertext: row.name_enc,
      keyVersion: row.name_key_version,
    }),
    email: await decrypt('email_enc', row.email_enc, row.email_key_version),
    phone: await decrypt('phone_enc', row.phone_enc, row.phone_key_version),
  };
}
