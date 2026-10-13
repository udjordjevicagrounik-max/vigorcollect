import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { logEvent } from '@/lib/log';
import {
  ConflictError,
  createTenantContext,
  NotFoundError,
  type TenantContext,
} from '@/server/auth/with-tenant';
import type { MasterKeyring } from '@/server/crypto/keyring';
import { emitEvent } from '@/server/events';
import type { TenantTx } from '@/server/jobs/tenant-job';
import { open, seal } from './crypto';
import { probeImap, probeSmtp, type ProbeResult } from './mail-probe';
import {
  n8nClient,
  n8nConfig,
  provisionMailbox,
  pushGraphToken,
  type N8nCall,
  type N8nRefs,
} from './n8n';
import { createIntegration, inboundPath, updateIntegration } from './service';

/**
 * Mailbox onboarding (5.3), Admin → Integrations → Mail.
 *
 * IMAP/SMTP form: hosts, ports, TLS, user, password, folder (default INBOX), sender. Secrets are
 * sealed with the tenant's integration key at once and never come back to the browser, a log or
 * an audit entry ("password set: yes"). "Check connection" only flips the status; the worker
 * (integrations-dispatch tick) probes IMAP login + SMTP EHLO OUTSIDE any transaction, then
 * provisions the tenant's n8n credentials and both workflows and activates them.
 *
 * Microsoft 365: OAuth2 authorization code + PKCE (scopes Mail.Read Mail.Send offline_access),
 * state bound to the member's SESSION and single use; the refresh token is sealed here and the
 * worker refreshes the access token and pushes it into the tenant's n8n bearer credential
 * (docs/adr/0007). Without MS_CLIENT_ID / MS_CLIENT_SECRET the button is not shown.
 * Google Workspace: "coming soon" (BACKLOG).
 */

const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export const mailboxFormSchema = z.object({
  imapHost: z.string().trim().regex(HOST),
  imapPort: z.union([z.literal(143), z.literal(993)]),
  imapTls: z.boolean(),
  smtpHost: z.string().trim().regex(HOST),
  smtpPort: z.union([z.literal(25), z.literal(465), z.literal(587), z.literal(2525)]),
  smtpSecurity: z.enum(['tls', 'starttls', 'none']),
  username: z.string().trim().min(1).max(320),
  /** Empty on an update = keep the stored one. */
  password: z.string().max(500).optional(),
  folder: z.string().trim().min(1).max(200).default('INBOX'),
  fromAddress: z.string().trim().regex(ADDRESS).max(320).optional(),
});
export type MailboxForm = z.input<typeof mailboxFormSchema>;

export type MailboxView = {
  provider: 'imap_smtp' | 'microsoft365' | null;
  status: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapTls: boolean | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: string | null;
  folder: string;
  passwordSet: boolean;
  usernameSet: boolean;
  fromAddressSet: boolean;
  lastTestAt: string | null;
  lastError: string | null;
  connected: boolean;
  microsoftAvailable: boolean;
};

export const microsoftAvailable = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);

type Row = {
  id: string;
  provider: 'imap_smtp' | 'microsoft365';
  status: string;
  imap_host: string | null;
  imap_port: number | null;
  imap_tls: boolean | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: 'tls' | 'starttls' | 'none' | null;
  folder: string;
  username_enc: Buffer | null;
  password_enc: Buffer | null;
  from_address_enc: Buffer | null;
  ms_refresh_token_enc: Buffer | null;
  username_key_version: number | null;
  password_key_version: number | null;
  from_address_key_version: number | null;
  ms_refresh_token_key_version: number | null;
  ms_access_expires_at: Date | null;
  integration_id: string | null;
  n8n_refs: N8nRefs;
  last_test_at: Date | null;
  last_error: string | null;
  requested_by: string;
};

async function current(db: TenantContext['db'], lock = false): Promise<Row | undefined> {
  const { rows } = await db.query<Row>(
    lock ? 'SELECT * FROM mailbox_connections FOR UPDATE' : 'SELECT * FROM mailbox_connections',
  );
  return rows[0];
}

export async function getMailbox(ctx: TenantContext): Promise<MailboxView> {
  await ctx.requirePermission('integration.read');
  const r = await current(ctx.db);
  return {
    provider: r?.provider ?? null,
    status: r?.status ?? null,
    imapHost: r?.imap_host ?? null,
    imapPort: r?.imap_port ?? null,
    imapTls: r?.imap_tls ?? null,
    smtpHost: r?.smtp_host ?? null,
    smtpPort: r?.smtp_port ?? null,
    smtpSecurity: r?.smtp_security ?? null,
    folder: r?.folder ?? 'INBOX',
    passwordSet: Boolean(r?.password_enc),
    usernameSet: Boolean(r?.username_enc),
    fromAddressSet: Boolean(r?.from_address_enc),
    lastTestAt: r?.last_test_at?.toISOString() ?? null,
    lastError: r?.last_error ?? null,
    connected: r?.status === 'connected',
    microsoftAvailable: microsoftAvailable(),
  };
}

/** Saves the IMAP/SMTP form (sealed secrets); status back to 'saved' until checked again. */
export async function saveMailboxForm(
  ctx: TenantContext,
  input: MailboxForm,
  keyring: MasterKeyring,
): Promise<{ ok: true }> {
  await ctx.requirePermission('integration.manage');
  const d = mailboxFormSchema.parse(input);
  const before = await current(ctx.db, true);
  const id = before?.id ?? randomUUID();
  // A new form, or a switch from Microsoft 365, needs the password.
  const keepPassword = !d.password && before?.provider === 'imap_smtp' && before.password_enc;
  if (!d.password && !keepPassword) throw new ConflictError('invalid_request');
  // Every secret of the row is sealed with the CURRENT key version (one version per row).
  const plainPassword =
    d.password ||
    open(keyring, ctx.tenantId, 'mailbox_connections.password', id, {
      ciphertext: before?.password_enc as Buffer,
      keyVersion: before?.password_key_version ?? 1,
    });
  const user = seal(keyring, ctx.tenantId, 'mailbox_connections.username', id, d.username);
  const pass = seal(keyring, ctx.tenantId, 'mailbox_connections.password', id, plainPassword);
  const from = d.fromAddress
    ? seal(keyring, ctx.tenantId, 'mailbox_connections.from_address', id, d.fromAddress)
    : null;
  await ctx.db.query(
    `INSERT INTO mailbox_connections (id, tenant_id, provider, status, imap_host, imap_port, imap_tls,
                                      smtp_host, smtp_port, smtp_security, folder, username_enc, password_enc,
                                      from_address_enc, username_key_version, password_key_version,
                                      from_address_key_version, requested_by)
     VALUES ($1, app_tenant_id(), 'imap_smtp', 'saved', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12,
             CASE WHEN $11::bytea IS NULL THEN NULL ELSE $12::int END, $13)
     ON CONFLICT (tenant_id) DO UPDATE SET provider = 'imap_smtp', status = 'saved',
       imap_host = $2, imap_port = $3, imap_tls = $4, smtp_host = $5, smtp_port = $6, smtp_security = $7,
       folder = $8, username_enc = $9, password_enc = $10, from_address_enc = $11,
       username_key_version = $12, password_key_version = $12,
       from_address_key_version = CASE WHEN $11::bytea IS NULL THEN NULL ELSE $12::int END,
       ms_refresh_token_enc = NULL, ms_refresh_token_key_version = NULL, ms_access_expires_at = NULL,
       requested_by = $13, last_error = NULL`,
    [
      id,
      d.imapHost,
      d.imapPort,
      d.imapTls,
      d.smtpHost,
      d.smtpPort,
      d.smtpSecurity,
      d.folder,
      user.ciphertext,
      pass.ciphertext,
      from?.ciphertext ?? null,
      keyring.current.version,
      ctx.userId,
    ],
  );
  await ctx.audit({
    action: 'mailbox.saved',
    entityType: 'mailbox_connections',
    entityId: id,
    ...(before ? { before: { provider: before.provider, status: before.status } } : {}),
    // Never a secret: only that they are set.
    after: {
      provider: 'imap_smtp',
      imap: `${d.imapHost}:${d.imapPort}`,
      smtp: `${d.smtpHost}:${d.smtpPort}`,
      folder: d.folder,
      password_set: true,
      from_set: Boolean(d.fromAddress),
    },
  });
  return { ok: true };
}

/** "Check connection": the worker probes and, on success, connects n8n. */
export async function requestMailboxTest(ctx: TenantContext): Promise<{ ok: true }> {
  await ctx.requirePermission('integration.manage');
  const r = await current(ctx.db, true);
  if (!r) throw new NotFoundError();
  await ctx.db.query(
    `UPDATE mailbox_connections SET status = 'test_requested', claimed_at = NULL, last_error = NULL,
            requested_by = $1 WHERE id = $2`,
    [ctx.userId, r.id],
  );
  await ctx.audit({
    action: 'mailbox.test_requested',
    entityType: 'mailbox_connections',
    entityId: r.id,
    before: { status: r.status },
    after: { status: 'test_requested' },
  });
  await emitEvent(ctx.db, {
    eventType: 'mailbox.test_requested',
    aggregateType: 'mailbox_connections',
    aggregateId: r.id,
    payload: { provider: r.provider },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Microsoft 365 (OAuth2 authorization code + PKCE)
// ---------------------------------------------------------------------------------------------

export const MS_SCOPES =
  'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send';
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const b64url = (b: Buffer) => b.toString('base64url');

function msEndpoints(env: NodeJS.ProcessEnv = process.env) {
  const tenant = env.MS_TENANT || 'common';
  if (!/^[A-Za-z0-9.-]{1,100}$/.test(tenant)) throw new ConflictError('unsupported');
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  return { authorize: `${base}/authorize`, token: `${base}/token` };
}

export const msRedirectUri = (env: NodeJS.ProcessEnv = process.env) =>
  `${new URL(env.BETTER_AUTH_URL ?? 'http://localhost:3000').origin}/api/integrations/microsoft/callback`;

/** Starts the consent: state + PKCE bound to this session; returns the Microsoft URL. */
export async function startMicrosoft(
  ctx: TenantContext,
  sessionId: string,
  keyring: MasterKeyring,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ url: string }> {
  await ctx.requirePermission('integration.manage');
  if (!microsoftAvailable(env)) throw new ConflictError('unsupported');
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const id = randomUUID();
  const sealed = seal(keyring, ctx.tenantId, 'oauth_states.verifier', id, verifier);
  await ctx.db.query('DELETE FROM oauth_states WHERE expires_at < now()');
  await ctx.db.query(
    `INSERT INTO oauth_states (id, tenant_id, user_id, provider, state_hash, session_hash, verifier_enc, verifier_key_version)
     VALUES ($1, app_tenant_id(), $2, 'microsoft365', $3, $4, $5, $6)`,
    [id, ctx.userId, sha256(state), sha256(sessionId), sealed.ciphertext, sealed.keyVersion],
  );
  await ctx.audit({
    action: 'mailbox.oauth_started',
    entityType: 'oauth_states',
    entityId: id,
    after: { provider: 'microsoft365' },
  });
  const params = new URLSearchParams({
    client_id: env.MS_CLIENT_ID ?? '',
    response_type: 'code',
    redirect_uri: msRedirectUri(env),
    response_mode: 'query',
    scope: MS_SCOPES,
    state,
    code_challenge: b64url(sha256(verifier)),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { url: `${msEndpoints(env).authorize}?${params.toString()}` };
}

export const callbackQuery = z.object({
  code: z.string().min(1).max(4000).optional(),
  state: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
  error: z.string().max(200).optional(),
});

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number };

async function tokenRequest(
  body: Record<string, string>,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const res = await fetchImpl(msEndpoints(env).token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID ?? '',
      client_secret: env.MS_CLIENT_SECRET ?? '',
      scope: MS_SCOPES,
      ...body,
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new ConflictError('conflict');
  return (await res.json()) as TokenResponse;
}

/**
 * The redirect back from Microsoft: state must exist, be unused, unexpired, of THIS member and
 * THIS session; then the code is exchanged (with the PKCE verifier) and the refresh token sealed.
 */
export async function finishMicrosoft(
  ctx: TenantContext,
  sessionId: string,
  query: z.infer<typeof callbackQuery>,
  keyring: MasterKeyring,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<'connected' | 'denied'> {
  await ctx.requirePermission('integration.manage');
  const { rows } = await ctx.db.query<{
    id: string;
    user_id: string;
    session_hash: Buffer;
    verifier_enc: Buffer;
    verifier_key_version: number;
  }>(
    `UPDATE oauth_states SET used_at = now()
     WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id, user_id, session_hash, verifier_enc, verifier_key_version`,
    [sha256(query.state)],
  );
  const s = rows[0];
  if (!s || s.user_id !== ctx.userId || !s.session_hash.equals(sha256(sessionId)))
    throw new NotFoundError();
  if (query.error || !query.code) return 'denied';
  const verifier = open(keyring, ctx.tenantId, 'oauth_states.verifier', s.id, {
    ciphertext: s.verifier_enc,
    keyVersion: s.verifier_key_version,
  });
  const tokens = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: msRedirectUri(env),
      code_verifier: verifier,
    },
    env,
    fetchImpl,
  );
  if (!tokens.refresh_token) throw new ConflictError('conflict');
  const before = await current(ctx.db, true);
  const id = before?.id ?? randomUUID();
  const sealed = seal(
    keyring,
    ctx.tenantId,
    'mailbox_connections.ms_refresh_token',
    id,
    tokens.refresh_token,
  );
  await ctx.db.query(
    `INSERT INTO mailbox_connections (id, tenant_id, provider, status, ms_refresh_token_enc, ms_refresh_token_key_version, requested_by)
     VALUES ($1, app_tenant_id(), 'microsoft365', 'test_requested', $2, $3, $4)
     ON CONFLICT (tenant_id) DO UPDATE SET provider = 'microsoft365', status = 'test_requested',
       ms_refresh_token_enc = $2, ms_refresh_token_key_version = $3, requested_by = $4, claimed_at = NULL,
       imap_host = NULL, imap_port = NULL, imap_tls = NULL, smtp_host = NULL, smtp_port = NULL,
       smtp_security = NULL, username_enc = NULL, password_enc = NULL, from_address_enc = NULL,
       username_key_version = NULL, password_key_version = NULL, from_address_key_version = NULL,
       last_error = NULL`,
    [id, sealed.ciphertext, sealed.keyVersion, ctx.userId],
  );
  await ctx.audit({
    action: 'mailbox.microsoft_connected',
    entityType: 'mailbox_connections',
    entityId: id,
    ...(before ? { before: { provider: before.provider, status: before.status } } : {}),
    after: { provider: 'microsoft365', refresh_token_set: true },
  });
  return 'connected';
}

// ---------------------------------------------------------------------------------------------
// Worker: probe → provision n8n (outside transactions), token refresh
// ---------------------------------------------------------------------------------------------

export type MailboxDeps = {
  probeImap?: typeof probeImap;
  probeSmtp?: typeof probeSmtp;
  n8n?: N8nCall | null;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

type Claimed = Row & { slug: string; tenant_id: string };

const fail = (run: TenantTx, id: string, error: string) =>
  run((db) =>
    db.query(
      `UPDATE mailbox_connections SET status = 'failed', last_error = $2, last_test_at = now(), claimed_at = NULL
       WHERE id = $1`,
      [id, error],
    ),
  );

/** One tenant (inside dispatchIntegrations): at most one connection to check per tick. */
export async function processMailbox(
  run: TenantTx,
  keyring: MasterKeyring,
  deps: MailboxDeps = {},
): Promise<'connected' | 'failed' | 'refreshed' | null> {
  const env = deps.env ?? process.env;
  const claimed = await run(async (db) => {
    const { rows } = await db.query<Claimed>(
      `UPDATE mailbox_connections m SET status = 'testing', claimed_at = now()
       FROM tenants t WHERE t.id = m.tenant_id
         AND (m.status = 'test_requested' OR (m.status = 'testing' AND m.claimed_at < now() - interval '5 minutes'))
       RETURNING m.*, t.slug`,
    );
    return rows[0];
  });
  if (!claimed) return refreshMicrosoft(run, keyring, deps);
  const secret = (
    target: Parameters<typeof open>[2],
    value: Buffer | null,
    version: number | null,
  ) =>
    value
      ? open(keyring, claimed.tenant_id, target, claimed.id, {
          ciphertext: value,
          keyVersion: version ?? 1,
        })
      : '';

  // 1. Probe (no transaction open).
  let mail: Parameters<typeof provisionMailbox>[1]['mail'];
  let refreshed: TokenResponse | null = null;
  if (claimed.provider === 'imap_smtp') {
    const user = secret(
      'mailbox_connections.username',
      claimed.username_enc,
      claimed.username_key_version,
    );
    const password = secret(
      'mailbox_connections.password',
      claimed.password_enc,
      claimed.password_key_version,
    );
    const imap: ProbeResult = await (deps.probeImap ?? probeImap)({
      host: claimed.imap_host ?? '',
      port: claimed.imap_port as 143 | 993,
      tls: Boolean(claimed.imap_tls),
      user,
      password,
    });
    if (!imap.ok) return fail(run, claimed.id, `imap_${imap.error}`).then(() => 'failed' as const);
    const smtpUser = claimed.smtp_security === 'none' ? '' : user;
    const smtp = await (deps.probeSmtp ?? probeSmtp)({
      host: claimed.smtp_host ?? '',
      port: claimed.smtp_port as 25 | 465 | 587 | 2525,
      security: claimed.smtp_security ?? 'starttls',
      user: smtpUser,
      password: smtpUser ? password : '',
    });
    if (!smtp.ok) return fail(run, claimed.id, `smtp_${smtp.error}`).then(() => 'failed' as const);
    mail = {
      kind: 'imap_smtp',
      imap: {
        user,
        password,
        host: claimed.imap_host ?? '',
        port: claimed.imap_port ?? 993,
        secure: Boolean(claimed.imap_tls),
      },
      smtp: {
        user: smtpUser,
        password: smtpUser ? password : '',
        host: claimed.smtp_host ?? '',
        port: claimed.smtp_port ?? 587,
        secure: claimed.smtp_security === 'tls',
        disableStartTls: claimed.smtp_security === 'none',
      },
    };
  } else {
    try {
      refreshed = await tokenRequest(
        {
          grant_type: 'refresh_token',
          refresh_token: secret(
            'mailbox_connections.ms_refresh_token',
            claimed.ms_refresh_token_enc,
            claimed.ms_refresh_token_key_version,
          ),
        },
        env,
        deps.fetchImpl ?? fetch,
      );
    } catch {
      return fail(run, claimed.id, 'ms_token_failed').then(() => 'failed' as const);
    }
    if (!refreshed.access_token)
      return fail(run, claimed.id, 'ms_token_failed').then(() => 'failed' as const);
    mail = { kind: 'microsoft365', accessToken: refreshed.access_token };
  }

  // 2. The tenant's mailbox integration (signing secret), as the member who asked.
  const cfg = n8nConfig(env);
  const call = deps.n8n === undefined ? (cfg ? n8nClient(cfg) : null) : deps.n8n;
  if (!call || !cfg)
    return fail(run, claimed.id, 'n8n_not_configured').then(() => 'failed' as const);
  const integration = await run(async (db) => {
    const ctx = createTenantContext(db as PoolClient, {
      tenantId: claimed.tenant_id,
      userId: claimed.requested_by,
      authUserId: 'job:mailbox',
      requestId: randomUUID(),
    });
    const { rows } = await db.query<{ id: string; cid: string; enc: Buffer; v: number }>(
      `SELECT i.id, c.id AS cid, c.secret_enc AS enc, c.secret_key_version AS v
       FROM integrations i JOIN integration_credentials c ON c.integration_id = i.id
       WHERE i.type = 'mailbox' AND i.status = 'active' AND c.purpose = 'signing' AND c.revoked_at IS NULL
       LIMIT 1`,
    );
    if (rows[0]) {
      const r = rows[0];
      return {
        id: r.id,
        secret: open(keyring, claimed.tenant_id, 'integration_credentials.secret', r.cid, {
          ciphertext: r.enc,
          keyVersion: r.v,
        }),
      };
    }
    const created = await createIntegration(
      ctx,
      { type: 'mailbox', name: 'Pošta (n8n)', events: [] },
      keyring,
    );
    return { id: created.id, secret: created.secret };
  });
  const origin = new URL(env.BETTER_AUTH_URL ?? 'http://localhost:3000').origin;

  // 3. n8n (no transaction open).
  let refs: N8nRefs;
  let outboundUrl: string;
  try {
    const fromAddress =
      secret(
        'mailbox_connections.from_address',
        claimed.from_address_enc,
        claimed.from_address_key_version,
      ) || null;
    const out = await provisionMailbox(call, {
      slug: claimed.slug,
      signingSecret: integration.secret,
      inboundUrl: `${origin}${inboundPath(integration.id)}`,
      folder: claimed.folder,
      fromAddress,
      mail,
      previous: claimed.n8n_refs,
    });
    refs = out.refs;
    outboundUrl = out.outboundUrl(cfg.base);
  } catch (error) {
    logEvent('mailbox.n8n_failed', {
      level: 'warn',
      name: error instanceof Error ? error.name : 'unknown',
      status: (error as { status?: number }).status ?? null,
    });
    return fail(run, claimed.id, 'n8n_failed').then(() => 'failed' as const);
  }

  // 4. Record (one transaction): integration URL, connection connected, audit.
  await run(async (db) => {
    const ctx = createTenantContext(db as PoolClient, {
      tenantId: claimed.tenant_id,
      userId: claimed.requested_by,
      authUserId: 'job:mailbox',
      requestId: randomUUID(),
    });
    await updateIntegration(ctx, integration.id, { outboundUrl });
    const rotated = refreshed?.refresh_token
      ? seal(
          keyring,
          claimed.tenant_id,
          'mailbox_connections.ms_refresh_token',
          claimed.id,
          refreshed.refresh_token,
        )
      : null;
    await db.query(
      `UPDATE mailbox_connections SET status = 'connected', last_error = NULL, last_test_at = now(),
              claimed_at = NULL, integration_id = $2, n8n_refs = $3::jsonb,
              ms_refresh_token_enc = coalesce($4, ms_refresh_token_enc),
              ms_refresh_token_key_version = coalesce($5, ms_refresh_token_key_version),
              ms_access_expires_at = CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(secs => $6::int) END
       WHERE id = $1`,
      [
        claimed.id,
        integration.id,
        JSON.stringify(refs),
        rotated?.ciphertext ?? null,
        rotated?.keyVersion ?? null,
        refreshed?.expires_in ?? null,
      ],
    );
    await ctx.audit({
      action: 'mailbox.connected',
      entityType: 'mailbox_connections',
      entityId: claimed.id,
      after: { provider: claimed.provider, integration_id: integration.id, workflows: 2 },
    });
  });
  return 'connected';
}

/** Microsoft 365: refresh the access token 10 minutes before it expires and push it to n8n. */
async function refreshMicrosoft(
  run: TenantTx,
  keyring: MasterKeyring,
  deps: MailboxDeps,
): Promise<'refreshed' | 'failed' | null> {
  const env = deps.env ?? process.env;
  const due = await run(async (db) => {
    const { rows } = await db.query<Claimed>(
      `SELECT m.*, t.slug FROM mailbox_connections m JOIN tenants t ON t.id = m.tenant_id
       WHERE m.provider = 'microsoft365' AND m.status = 'connected'
         AND (m.ms_access_expires_at IS NULL OR m.ms_access_expires_at < now() + interval '10 minutes')`,
    );
    return rows[0];
  });
  if (!due?.n8n_refs.graphCredential) return null;
  const cfg = n8nConfig(env);
  const call = deps.n8n === undefined ? (cfg ? n8nClient(cfg) : null) : deps.n8n;
  if (!call) return null;
  try {
    const tokens = await tokenRequest(
      {
        grant_type: 'refresh_token',
        refresh_token: open(
          keyring,
          due.tenant_id,
          'mailbox_connections.ms_refresh_token',
          due.id,
          {
            ciphertext: due.ms_refresh_token_enc as Buffer,
            keyVersion: due.ms_refresh_token_key_version ?? 1,
          },
        ),
      },
      env,
      deps.fetchImpl ?? fetch,
    );
    if (!tokens.access_token) throw new ConflictError('conflict');
    await pushGraphToken(call, due.n8n_refs.graphCredential, due.slug, tokens.access_token);
    const rotated = tokens.refresh_token
      ? seal(
          keyring,
          due.tenant_id,
          'mailbox_connections.ms_refresh_token',
          due.id,
          tokens.refresh_token,
        )
      : null;
    await run((db) =>
      db.query(
        `UPDATE mailbox_connections SET ms_access_expires_at = now() + make_interval(secs => $2::int),
                ms_refresh_token_enc = coalesce($3, ms_refresh_token_enc),
                ms_refresh_token_key_version = coalesce($4, ms_refresh_token_key_version)
         WHERE id = $1`,
        [
          due.id,
          tokens.expires_in ?? 3600,
          rotated?.ciphertext ?? null,
          rotated?.keyVersion ?? null,
        ],
      ),
    );
    return 'refreshed';
  } catch {
    await fail(run, due.id, 'ms_token_failed');
    return 'failed';
  }
}
