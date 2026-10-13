import inboundGraph from '../../../docs/integrations/n8n/mail-inbound-graph.json' with { type: 'json' };
import inboundImap from '../../../docs/integrations/n8n/mail-inbound.json' with { type: 'json' };
import outboundGraph from '../../../docs/integrations/n8n/mail-outbound-graph.json' with { type: 'json' };
import outboundSmtp from '../../../docs/integrations/n8n/mail-outbound.json' with { type: 'json' };

/**
 * n8n provisioning from the service (5.3) — the logic of scripts/n8n-connect.ts per tenant:
 * signing credential, mail credentials (IMAP + SMTP, or a Microsoft Graph bearer header), the two
 * workflows from docs/integrations/n8n/ with tenant-specific names and webhook paths, bound by
 * credential id, then activated. Runs in the WORKER, outside any transaction (review S-09); the
 * caller records the returned ids (P0). Errors carry the status and n8n's short message — never a
 * value we sent.
 *
 * Env: N8N_BASE_URL, N8N_API_KEY (worker). Without them: not configured.
 */

type Json = Record<string, unknown>;
type Node = { name: string; type: string; parameters: Json; credentials?: Json };
type Workflow = { name: string; nodes: Node[]; connections: Json; settings?: Json };

export class N8nError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'N8nError';
  }
}

export type N8nConfig = { base: string; apiKey: string };

export function n8nConfig(env: NodeJS.ProcessEnv = process.env): N8nConfig | null {
  const { N8N_BASE_URL: baseUrl, N8N_API_KEY: apiKey } = env;
  if (!baseUrl || !apiKey) return null;
  const url = new URL(baseUrl);
  return { base: url.origin + url.pathname.replace(/\/$/, ''), apiKey };
}

export function n8nClient(cfg: N8nConfig, fetchImpl: typeof fetch = fetch) {
  return async function call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${cfg.base}/api/v1/${path}`, {
      method,
      headers: { 'X-N8N-API-KEY': cfg.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = '';
      try {
        message = String((JSON.parse(text) as Json).message ?? '').slice(0, 120);
      } catch {
        message = '';
      }
      throw new N8nError(
        res.status,
        `n8n ${method} ${path.split('?')[0]} → ${res.status} ${message}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  };
}
export type N8nCall = ReturnType<typeof n8nClient>;

export type MailCredentials =
  | {
      kind: 'imap_smtp';
      imap: { user: string; password: string; host: string; port: number; secure: boolean };
      smtp: {
        user: string;
        password: string;
        host: string;
        port: number;
        secure: boolean;
        disableStartTls: boolean;
      };
    }
  | { kind: 'microsoft365'; accessToken: string };

export type ProvisionInput = {
  /** Tenant slug — names and webhook paths are unique per tenant. */
  slug: string;
  signingSecret: string;
  inboundUrl: string;
  folder: string;
  fromAddress: string | null;
  mail: MailCredentials;
  /** Ids from an earlier provisioning (replaced). */
  previous?: N8nRefs;
};

export type N8nRefs = {
  credentials?: string[];
  workflows?: { inbound: string; outbound: string };
  graphCredential?: string;
};

// Bundled with the code (the images carry no docs/); a deep copy per use.
const TEMPLATES = {
  'mail-inbound.json': inboundImap,
  'mail-outbound.json': outboundSmtp,
  'mail-inbound-graph.json': inboundGraph,
  'mail-outbound-graph.json': outboundGraph,
} as const;
const template = (file: keyof typeof TEMPLATES) =>
  structuredClone(TEMPLATES[file]) as unknown as Workflow;

export const outboundPath = (slug: string) => `collect-mail-outbound-${slug}`;

/** Creates / replaces everything for one tenant and activates both workflows. */
export async function provisionMailbox(
  call: N8nCall,
  input: ProvisionInput,
): Promise<{ refs: N8nRefs; outboundUrl: (base: string) => string }> {
  const names = {
    signing: `collect-signing-${input.slug}`,
    imap: `collect-imap-${input.slug}`,
    smtp: `collect-smtp-${input.slug}`,
    graph: `collect-ms-${input.slug}`,
    inbound: `Collect — mail inbound — ${input.slug}`,
    outbound: `Collect — mail outbound — ${input.slug}`,
  };
  // Old credentials of this tenant go (n8n cannot read a secret back; recreated with the values).
  const list = await call<{ data: { id: string; name: string }[] }>('GET', 'credentials?limit=250');
  const ours = new Set([names.signing, names.imap, names.smtp, names.graph]);
  for (const c of list.data.filter((c) => ours.has(c.name))) {
    await call('DELETE', `credentials/${c.id}`).catch(() => undefined);
  }
  const create = (name: string, type: string, data: Json) =>
    call<{ id: string; name: string }>('POST', 'credentials', { name, type, data });
  const signing = await create(names.signing, 'crypto', { hmacSecret: input.signingSecret });
  const created: Record<string, { id: string; name: string }> = { crypto: signing };
  if (input.mail.kind === 'imap_smtp') {
    created.imap = await create(names.imap, 'imap', {
      ...input.mail.imap,
      allowUnauthorizedCerts: false,
    });
    created.smtp = await create(names.smtp, 'smtp', { ...input.mail.smtp, hostName: '' });
  } else {
    created.httpHeaderAuth = await create(names.graph, 'httpHeaderAuth', {
      name: 'Authorization',
      value: `Bearer ${input.mail.accessToken}`,
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'graph.microsoft.com',
    });
  }

  const files =
    input.mail.kind === 'imap_smtp'
      ? ({ inbound: 'mail-inbound.json', outbound: 'mail-outbound.json' } as const)
      : ({ inbound: 'mail-inbound-graph.json', outbound: 'mail-outbound-graph.json' } as const);
  const existing = await call<{ data: { id: string; name: string; active: boolean }[] }>(
    'GET',
    'workflows?limit=250',
  );
  const ids: Record<'inbound' | 'outbound', string> = { inbound: '', outbound: '' };
  for (const which of ['inbound', 'outbound'] as const) {
    const w = template(files[which]);
    for (const node of w.nodes) {
      if (node.type === 'n8n-nodes-base.crypto') node.credentials = { crypto: created.crypto };
      if (node.type === 'n8n-nodes-base.webhook') node.parameters.path = outboundPath(input.slug);
      if (node.type === 'n8n-nodes-base.emailReadImap') {
        node.parameters.mailbox = input.folder;
        node.credentials = { imap: created.imap };
      }
      if (node.type === 'n8n-nodes-base.emailSend') {
        node.credentials = { smtp: created.smtp };
        if (input.fromAddress) node.parameters.fromEmail = input.fromAddress;
      }
      if (node.type === 'n8n-nodes-base.httpRequest' && node.name === 'Send to Collect')
        node.parameters.url = input.inboundUrl;
      if (node.type === 'n8n-nodes-base.httpRequest' && node.name.startsWith('Graph'))
        node.credentials = { httpHeaderAuth: created.httpHeaderAuth };
      if (node.type === 'n8n-nodes-base.code' && node.name === 'Folder')
        node.parameters.jsCode = `return [{ json: { folder: ${JSON.stringify(input.folder)} } }];`;
    }
    const body = {
      name: names[which],
      nodes: w.nodes,
      connections: w.connections,
      settings: w.settings ?? { executionOrder: 'v1' },
    };
    const prior = existing.data.find((x) => x.name === names[which]);
    if (prior) {
      if (prior.active) await call('POST', `workflows/${prior.id}/deactivate`);
      await call('PUT', `workflows/${prior.id}`, body);
      ids[which] = prior.id;
    } else ids[which] = (await call<{ id: string }>('POST', 'workflows', body)).id;
    await call('POST', `workflows/${ids[which]}/activate`);
  }
  return {
    refs: {
      credentials: Object.values(created).map((c) => c.id),
      workflows: ids,
      ...(created.httpHeaderAuth ? { graphCredential: created.httpHeaderAuth.id } : {}),
    },
    outboundUrl: (base) => `${base}/webhook/${outboundPath(input.slug)}`,
  };
}

/** Microsoft 365: the fresh access token into the tenant's bearer credential (PATCH). */
export async function pushGraphToken(
  call: N8nCall,
  credentialId: string,
  slug: string,
  token: string,
) {
  await call('PATCH', `credentials/${credentialId}`, {
    name: `collect-ms-${slug}`,
    type: 'httpHeaderAuth',
    data: {
      name: 'Authorization',
      value: `Bearer ${token}`,
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'graph.microsoft.com',
    },
  });
}
