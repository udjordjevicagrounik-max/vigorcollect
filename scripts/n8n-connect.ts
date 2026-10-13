/**
 * Connects the n8n of this server to Collect for the tenant Sinergista (#0) — idempotent, prints
 * NO secret (session 5.1, docs/runbook.md "n8n povezivanje").
 *
 *   npx tsx scripts/n8n-connect.ts --smtp="<n8n SMTP credential>" --from="<sender address>" \
 *     [--imap="<n8n IMAP credential>"]
 *
 *   a) a mailbox integration through OUR integration service (audit, encrypted secret), outbound
 *      URL {N8N_BASE_URL}webhook/collect-mail-outbound; an existing active one with that URL is
 *      reused and its secret read back (decrypted here, never printed) — no rotation;
 *   b) the signing secret goes to n8n through its API as credential "collect-signing" (type
 *      crypto, used by the Crypto nodes of both workflows); recreated on every run, same value;
 *   c) both workflows from docs/integrations/n8n/ are created or updated by name, the inbound URL
 *      is set, credentials are bound BY NAME (collect-signing, --imap, --smtp), then activated;
 *      without --imap/--smtp (or when n8n has no credential of that name) that workflow stays
 *      inactive (each workflow independently); --from sets the sender of the SMTP node;
 *   d) "Test ping" through our outbound path — only its status is printed.
 *
 * Env (.env): DATABASE_URL (vigor_app), PII_MASTER_KEYS, BETTER_AUTH_URL (public origin of
 * Collect, for the inbound URL), N8N_BASE_URL, N8N_API_KEY.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createTenantContext } from '../src/server/auth/with-tenant';
import { parseMasterKeyring } from '../src/server/crypto/keyring';
import { open } from '../src/server/integrations/crypto';
import { ping } from '../src/server/integrations/outbound';
import { createIntegration } from '../src/server/integrations/service';

const SINERGISTA = {
  tenantId: '00000000-0000-4000-8000-000000000000',
  userId: '00000000-0000-4000-8000-000000000a00',
} as const;
const SIGNING_CREDENTIAL = 'collect-signing';
const WORKFLOWS = [
  { file: 'docs/integrations/n8n/mail-inbound.json', name: 'Collect — mail inbound', mail: 'imap' },
  {
    file: 'docs/integrations/n8n/mail-outbound.json',
    name: 'Collect — mail outbound',
    mail: 'smtp',
  },
] as const;

type Json = Record<string, unknown>;
type Node = { name: string; type: string; parameters: Json; credentials?: Json };
type Workflow = { name: string; nodes: Node[]; connections: Json; settings?: Json };

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) || undefined : undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (.env)`);
  return value;
}

/** n8n public API; errors carry the status and a short, secret-free message. */
function n8n(base: string, apiKey: string) {
  return async function call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}/api/v1/${path}`, {
      method,
      headers: { 'X-N8N-API-KEY': apiKey, 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const message = (() => {
        try {
          return String((JSON.parse(text) as Json).message ?? '').slice(0, 200);
        } catch {
          return '';
        }
      })();
      throw new Error(`n8n ${method} ${path.split('?')[0]} → ${res.status} ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  };
}

async function inTenant<T>(
  client: Client,
  fn: (ctx: ReturnType<typeof createTenantContext>) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [SINERGISTA.tenantId]);
    const ctx = createTenantContext(client as never, {
      tenantId: SINERGISTA.tenantId,
      userId: SINERGISTA.userId,
      authUserId: 'script:n8n-connect',
      requestId: randomUUID(),
    });
    const result = await fn(ctx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  process.loadEnvFile('.env');
  const dbUrl = required('DATABASE_URL');
  if (/_test(\?|$)/.test(new URL(dbUrl).pathname))
    throw new Error('DATABASE_URL must not be a test DB.');
  const keyring = parseMasterKeyring(required('PII_MASTER_KEYS'));
  const collectOrigin = new URL(required('BETTER_AUTH_URL')).origin;
  const n8nBase = new URL(required('N8N_BASE_URL'));
  const base = n8nBase.origin + n8nBase.pathname.replace(/\/$/, '');
  const api = n8n(base, required('N8N_API_KEY'));
  const outboundUrl = `${base}/webhook/collect-mail-outbound`;
  const mailCredentials = { imap: arg('imap'), smtp: arg('smtp') };
  const from = arg('from');
  if (from && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) throw new Error('--from is not an address');

  // a) the integration (our service) — reuse an active one with the same outbound URL.
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  let integrationId: string;
  let secret: string;
  let integration: 'created' | 'reused';
  try {
    const found = await inTenant(client, async (ctx) => {
      const { rows } = await ctx.db.query<{ id: string; cid: string; enc: Buffer; v: number }>(
        `SELECT i.id, c.id AS cid, c.secret_enc AS enc, c.secret_key_version AS v
         FROM integrations i JOIN integration_credentials c ON c.integration_id = i.id
         WHERE i.type = 'mailbox' AND i.status = 'active' AND i.config->>'outboundUrl' = $1
           AND c.purpose = 'signing' AND c.revoked_at IS NULL
         ORDER BY i.created_at LIMIT 1`,
        [outboundUrl],
      );
      return rows[0];
    });
    if (found) {
      integrationId = found.id;
      secret = open(keyring, SINERGISTA.tenantId, 'integration_credentials.secret', found.cid, {
        ciphertext: found.enc,
        keyVersion: found.v,
      });
      integration = 'reused';
    } else {
      const created = await inTenant(client, (ctx) =>
        createIntegration(
          ctx,
          { type: 'mailbox', name: 'n8n pošta', outboundUrl, events: [] },
          keyring,
        ),
      );
      integrationId = created.id;
      secret = created.secret;
      integration = 'created';
    }
  } catch (error) {
    await client.end();
    throw error;
  }
  const inboundUrl = `${collectOrigin}/api/integrations/${integrationId}/inbound`;

  // b) credential "collect-signing" (type crypto) — n8n cannot read a secret back, so it is
  // recreated with the same value; the workflows are re-bound below.
  const list = await api<{ data: { id: string; name: string; type: string }[] }>(
    'GET',
    'credentials?limit=250',
  );
  for (const c of list.data.filter((c) => c.name === SIGNING_CREDENTIAL)) {
    await api('DELETE', `credentials/${c.id}`);
  }
  const signing = await api<{ id: string; name: string }>('POST', 'credentials', {
    name: SIGNING_CREDENTIAL,
    type: 'crypto',
    data: { hmacSecret: secret },
  });
  const byName = (type: string, name: string | undefined) =>
    name ? list.data.find((c) => c.type === type && c.name === name) : undefined;
  const bound = {
    imap: byName('imap', mailCredentials.imap),
    smtp: byName('smtp', mailCredentials.smtp),
  };

  // c) workflows: create or update by name, bind credentials by name, activate if complete.
  const existing = await api<{ data: { id: string; name: string; active: boolean }[] }>(
    'GET',
    'workflows?limit=250',
  );
  const result: { name: string; id: string; active: boolean; missing: string | null }[] = [];
  for (const spec of WORKFLOWS) {
    const template = JSON.parse(readFileSync(spec.file, 'utf8')) as Workflow;
    const mail = bound[spec.mail];
    for (const node of template.nodes) {
      if (node.type === 'n8n-nodes-base.crypto') {
        node.credentials = { crypto: { id: signing.id, name: signing.name } };
      }
      if (node.type === 'n8n-nodes-base.emailSend' && from) {
        node.parameters.fromEmail = from;
      }
      if (node.type === 'n8n-nodes-base.httpRequest' && node.name === 'Send to Collect') {
        node.parameters.url = inboundUrl;
      }
      if (node.credentials && spec.mail in node.credentials) {
        // No credential of that name yet: unbound (the workflow stays inactive).
        node.credentials = mail ? { [spec.mail]: { id: mail.id, name: mail.name } } : {};
      }
    }
    const body = {
      name: spec.name,
      nodes: template.nodes,
      connections: template.connections,
      settings: template.settings ?? { executionOrder: 'v1' },
    };
    const prior = existing.data.find((w) => w.name === spec.name);
    let id: string;
    if (prior) {
      if (prior.active) await api('POST', `workflows/${prior.id}/deactivate`);
      await api('PUT', `workflows/${prior.id}`, body);
      id = prior.id;
    } else {
      id = (await api<{ id: string }>('POST', 'workflows', body)).id;
    }
    let active = false;
    if (mail) {
      await api('POST', `workflows/${id}/activate`);
      active = true;
    }
    result.push({ name: spec.name, id, active, missing: mail ? null : spec.mail });
  }

  // d) Test ping through our outbound path (signed POST to the outbound workflow).
  // n8n registers the webhook a moment after activation: a 404 right then is retried briefly.
  let pinged = await inTenant(client, (ctx) => ping(ctx.db, keyring, integrationId));
  for (let i = 0; i < 5 && pinged.httpStatus === 404 && result.some((w) => w.active); i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    pinged = await inTenant(client, (ctx) => ping(ctx.db, keyring, integrationId));
  }
  await client.end();

  const say = (line: string) => process.stdout.write(`${line}\n`);
  say(`integration: ${integration}`);
  say(`credential ${SIGNING_CREDENTIAL}: written`);
  for (const w of result) {
    say(
      `workflow "${w.name}": id ${w.id}, ${w.active ? 'active' : `INACTIVE — no ${w.missing} credential (--${w.missing}=<name>)`}`,
    );
  }
  say(
    `ping: ${pinged.status}${pinged.httpStatus ? ` (HTTP ${pinged.httpStatus})` : ''}${pinged.error ? ` ${pinged.error}` : ''}`,
  );
}

main().catch((error: unknown) => {
  // Only the message: never a stack with values, never a secret.
  console.error(`n8n-connect: ${error instanceof Error ? error.message : 'failed'}`);
  process.exit(1);
});
