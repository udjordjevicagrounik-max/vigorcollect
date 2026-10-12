import { Client } from 'pg';
import { parseMasterKeyring } from '../../src/server/crypto/keyring';
import { readOutbox } from '../../src/server/mail/adapter';
import { e2eDatabaseUrls } from './e2e-env';
import { E2E } from './global-setup';

/**
 * Reads the newest invitation link for `email` from the demo tenant's mail sink (collect_test),
 * decrypting with PII_MASTER_KEYS from .env — exactly what a person would click. Never printed.
 */
export async function invitationLink(email: string): Promise<string> {
  const client = new Client({ connectionString: e2eDatabaseUrls().app });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [E2E.tenantId]);
    const mails = await readOutbox(client, parseMasterKeyring(process.env.PII_MASTER_KEYS), {
      kind: 'invitation',
      limit: 20,
    });
    await client.query('COMMIT');
    const mail = mails.find((m) => m.to === email);
    const url = /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]{43}/.exec(mail?.text ?? '')?.[0];
    if (!url) throw new Error('invitation mail not found in the sink');
    return new URL(url).pathname;
  } finally {
    await client.end();
  }
}
