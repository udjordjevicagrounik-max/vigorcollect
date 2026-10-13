import { lookup } from 'node:dns/promises';
import { isIP, Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

/**
 * "Check connection" of a mailbox (5.3): IMAP login and SMTP EHLO (+ AUTH when a user is given)
 * from the WORKER, outside any database transaction. Credentials never reach a log; the result is
 * only a code. Guard against SSRF: ports from a fixed list (also a DB CHECK), every resolved
 * address must be public — private, loopback, link-local and CGNAT ranges are refused unless
 * MAILBOX_ALLOW_PRIVATE_HOSTS=1 (dev: the local SMTP relay on 172.17.0.1). A password never goes
 * over an unencrypted connection: IMAP on 143 must offer STARTTLS, SMTP without TLS may not AUTH.
 *
 * Why not n8n: the IMAP node of n8n is a trigger only (it cannot be run as a one-off login test)
 * and the public API has no credential test — see docs/adr/0007.
 */

export const PROBE_ERRORS = [
  'blocked_host',
  'dns_failed',
  'connect_failed',
  'tls_failed',
  'no_starttls',
  'auth_failed',
  'insecure_auth',
  'protocol_error',
  'timeout',
] as const;
export type ProbeError = (typeof PROBE_ERRORS)[number];
export type ProbeResult = { ok: true } | { ok: false; error: ProbeError };

export type ImapTarget = {
  host: string;
  port: 143 | 993;
  tls: boolean;
  user: string;
  password: string;
};
export type SmtpTarget = {
  host: string;
  port: 25 | 465 | 587 | 2525;
  security: 'tls' | 'starttls' | 'none';
  user: string;
  password: string;
};

const TIMEOUT_MS = 15_000;

/** IPv4 / IPv6 ranges that never belong to a customer's mail server. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80') ||
    v6.startsWith('ff')
  );
}

/** Resolves the host and returns ONE checked address to connect to (no re-resolution later). */
export async function safeAddress(
  host: string,
  allowPrivate = process.env.MAILBOX_ALLOW_PRIVATE_HOSTS === '1',
): Promise<{ address: string } | { error: ProbeError }> {
  let addresses: { address: string }[];
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    return { error: 'dns_failed' };
  }
  if (!addresses.length) return { error: 'dns_failed' };
  if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address)))
    return { error: 'blocked_host' };
  return { address: addresses[0]?.address ?? '' };
}

/** A line-oriented conversation over a socket that can be upgraded to TLS. */
class Conversation {
  private buffer = '';
  private waiters: ((line: string | null) => void)[] = [];
  private closed = false;

  constructor(private socket: Socket | TLSSocket) {
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    });
    socket.on('close', () => {
      this.closed = true;
      this.flush();
    });
    socket.on('error', () => {
      this.closed = true;
      this.flush();
    });
  }

  private flush() {
    for (;;) {
      const i = this.buffer.indexOf('\n');
      if (i < 0) break;
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      const w = this.waiters.shift();
      if (w) w(line);
      else {
        this.buffer = `${line}\n${this.buffer}`;
        break;
      }
    }
    if (this.closed) while (this.waiters.length) this.waiters.shift()?.(null);
  }

  line(): Promise<string | null> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.flush();
    });
  }

  send(text: string) {
    this.socket.write(`${text}\r\n`);
  }

  /** STARTTLS: the same TCP connection, now encrypted (certificate checked against `host`). */
  async upgrade(host: string): Promise<boolean> {
    const plain = this.socket;
    plain.removeAllListeners('data');
    const secure = tlsConnect({ socket: plain, servername: isIP(host) ? undefined : host });
    const ok = await new Promise<boolean>((resolve) => {
      secure.once('secureConnect', () => resolve(true));
      secure.once('error', () => resolve(false));
    });
    if (ok) {
      this.socket = secure;
      this.buffer = '';
      this.attach(secure);
    }
    return ok;
  }

  end() {
    this.socket.destroy();
  }
}

async function open(
  host: string,
  address: string,
  port: number,
  tls: boolean,
): Promise<Conversation | ProbeError> {
  return new Promise((resolve) => {
    const socket = tls
      ? tlsConnect({ host: address, port, servername: isIP(host) ? undefined : host })
      : new Socket().connect(port, address);
    socket.setTimeout(TIMEOUT_MS, () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once(tls ? 'secureConnect' : 'connect', () => resolve(new Conversation(socket)));
    socket.once('error', (e: NodeJS.ErrnoException) =>
      resolve(tls && /certificate|ssl|tls/i.test(e.message) ? 'tls_failed' : 'connect_failed'),
    );
  });
}

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** IMAP: greeting → [STARTTLS] → LOGIN → LOGOUT. */
export async function probeImap(t: ImapTarget): Promise<ProbeResult> {
  const addr = await safeAddress(t.host);
  if ('error' in addr) return { ok: false, error: addr.error };
  const c = await open(t.host, addr.address, t.port, t.tls);
  if (typeof c === 'string') return { ok: false, error: c };
  const timer = setTimeout(() => c.end(), TIMEOUT_MS);
  try {
    const tagged = async (tag: string): Promise<string | null> => {
      for (;;) {
        const l = await c.line();
        if (l === null || l.startsWith(`${tag} `)) return l;
      }
    };
    const greeting = await c.line();
    if (!greeting?.startsWith('* OK')) return { ok: false, error: 'protocol_error' };
    if (!t.tls) {
      c.send('a1 STARTTLS');
      const r = await tagged('a1');
      if (!r?.startsWith('a1 OK')) return { ok: false, error: 'no_starttls' };
      if (!(await c.upgrade(t.host))) return { ok: false, error: 'tls_failed' };
    }
    c.send(`a2 LOGIN ${quote(t.user)} ${quote(t.password)}`);
    const login = await tagged('a2');
    if (login === null) return { ok: false, error: 'timeout' };
    if (!login.startsWith('a2 OK')) return { ok: false, error: 'auth_failed' };
    c.send('a3 LOGOUT');
    return { ok: true };
  } finally {
    clearTimeout(timer);
    c.end();
  }
}

/** SMTP: greeting → EHLO → [STARTTLS → EHLO] → [AUTH PLAIN] → QUIT. No mail is sent. */
export async function probeSmtp(t: SmtpTarget, ehloName = 'collect.invalid'): Promise<ProbeResult> {
  if (t.security === 'none' && t.user) return { ok: false, error: 'insecure_auth' };
  const addr = await safeAddress(t.host);
  if ('error' in addr) return { ok: false, error: addr.error };
  const c = await open(t.host, addr.address, t.port, t.security === 'tls');
  if (typeof c === 'string') return { ok: false, error: c };
  const timer = setTimeout(() => c.end(), TIMEOUT_MS);
  try {
    /** A (multi-line) reply: its code and the lines. */
    const reply = async (): Promise<{ code: number; lines: string[] } | null> => {
      const lines: string[] = [];
      for (;;) {
        const l = await c.line();
        if (l === null) return null;
        lines.push(l);
        if (!/^\d{3}-/.test(l)) return { code: Number(l.slice(0, 3)), lines };
      }
    };
    const greeting = await reply();
    if (!greeting || greeting.code !== 220) return { ok: false, error: 'protocol_error' };
    c.send(`EHLO ${ehloName}`);
    let ehlo = await reply();
    if (!ehlo || ehlo.code !== 250) return { ok: false, error: 'protocol_error' };
    if (t.security === 'starttls') {
      if (!ehlo.lines.some((l) => /^250[ -]STARTTLS/i.test(l)))
        return { ok: false, error: 'no_starttls' };
      c.send('STARTTLS');
      const go = await reply();
      if (!go || go.code !== 220) return { ok: false, error: 'no_starttls' };
      if (!(await c.upgrade(t.host))) return { ok: false, error: 'tls_failed' };
      c.send(`EHLO ${ehloName}`);
      ehlo = await reply();
      if (!ehlo || ehlo.code !== 250) return { ok: false, error: 'protocol_error' };
    }
    if (t.user) {
      const token = Buffer.from(`\u0000${t.user}\u0000${t.password}`, 'utf8').toString('base64');
      c.send(`AUTH PLAIN ${token}`);
      const auth = await reply();
      if (!auth) return { ok: false, error: 'timeout' };
      if (auth.code !== 235) return { ok: false, error: 'auth_failed' };
    }
    c.send('QUIT');
    return { ok: true };
  } finally {
    clearTimeout(timer);
    c.end();
  }
}
