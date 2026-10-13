import type { Pool } from 'pg';
import { z } from 'zod';
import { logEvent } from '@/lib/log';
import type { MasterKeyring } from '@/server/crypto/keyring';
import { open } from '@/server/integrations/crypto';
import { SIGNATURE_HEADER, verifySignature } from '@/server/integrations/signing';

/**
 * Pipedrive lead (6.4): the outbound event signup.created carries ids only; n8n then asks for the
 * lead's details with a SIGNED GET (X-Signature over "<t>.GET <path>", the integration's secret).
 * Only an active integration of the platform operator tenant subscribed to signup.created gets
 * them; anything else is a 401 with no detail.
 */
export type LeadResult =
  | {
      status: 200;
      lead: { company: string; name: string; email: string; country: string; locale: string };
    }
  | { status: 401 | 404 };

export async function readLead(
  pool: Pool,
  keyring: MasterKeyring,
  integrationId: string,
  signupId: string,
  path: string,
  headers: Headers,
  now: Date = new Date(),
): Promise<LeadResult> {
  if (!z.uuid().safeParse(integrationId).success || !z.uuid().safeParse(signupId).success)
    return { status: 401 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.inbound_integration_id', $1, true)", [
      integrationId,
    ]);
    const found = await client.query<{ tenant_id: string; status: string }>(
      'SELECT tenant_id, status FROM integrations WHERE id = app_inbound_integration_id()',
    );
    const integration = found.rows[0];
    const { rows: opRows } = await client.query<{ op: string | null }>(
      'SELECT platform_operator_id() AS op',
    );
    if (!integration || integration.status !== 'active' || integration.tenant_id !== opRows[0]?.op)
      return { status: 401 };
    await client.query('RESET app.inbound_integration_id');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [integration.tenant_id]);
    const cred = await client.query<{
      id: string;
      secret_enc: Buffer;
      key_version: number;
      subscribed: boolean;
    }>(
      `SELECT c.id, c.secret_enc, c.secret_key_version AS key_version,
              (i.config->'events') ? 'signup.created' AS subscribed
       FROM integration_credentials c JOIN integrations i ON i.id = c.integration_id
       WHERE c.integration_id = $1 AND c.purpose = 'signing' AND c.revoked_at IS NULL`,
      [integrationId],
    );
    const c = cred.rows[0];
    if (!c?.subscribed) return { status: 401 };
    const secret = open(keyring, integration.tenant_id, 'integration_credentials.secret', c.id, {
      ciphertext: c.secret_enc,
      keyVersion: c.key_version,
    });
    if (verifySignature(headers.get(SIGNATURE_HEADER), `GET ${path}`, secret, now) !== 'ok') {
      logEvent('lead.rejected', { level: 'warn', reason: 'signature' });
      return { status: 401 };
    }
    const { rows } = await client.query<{
      id: string;
      company_enc: Buffer;
      company_key_version: number;
      name_enc: Buffer;
      name_key_version: number;
      email_enc: Buffer;
      email_key_version: number;
      country_code: string;
      locale: string;
    }>('SELECT * FROM signup_requests WHERE id = $1', [signupId]);
    const r = rows[0];
    if (!r) return { status: 404 };
    const unseal = (
      target: 'signup_requests.company' | 'signup_requests.name' | 'signup_requests.email',
      v: Buffer,
      k: number,
    ) => open(keyring, integration.tenant_id, target, r.id, { ciphertext: v, keyVersion: k });
    return {
      status: 200,
      lead: {
        company: unseal('signup_requests.company', r.company_enc, r.company_key_version),
        name: unseal('signup_requests.name', r.name_enc, r.name_key_version),
        email: unseal('signup_requests.email', r.email_enc, r.email_key_version),
        country: r.country_code,
        locale: r.locale,
      },
    };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
