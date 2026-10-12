// Guard for dev-only scripts that touch credentials (scripts/dev-admin-password.ts).
// Every condition must hold; anything unparsable counts as "not dev". The database host is NOT
// a criterion: on this machine and on Elestio alike Postgres is reached at 172.17.0.1, so it
// cannot tell dev from prod — the public app URL can.

export type DevGuardInput = {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  appUrl: string | undefined;
  stdoutIsTTY: boolean;
};

const LOCAL_APP_HOSTS = new Set(['localhost', '127.0.0.1']);
const DEV_DATABASE = 'collect';

/** Reasons the script must refuse to run; empty = allowed. */
export function devGuardViolations(input: DevGuardInput): string[] {
  const reasons: string[] = [];
  if (input.nodeEnv === 'production') reasons.push('NODE_ENV is production');

  let dbName = '';
  try {
    dbName = decodeURIComponent(new URL(input.databaseUrl ?? '').pathname.replace(/^\//, ''));
  } catch {
    // unparsable → no name → refused below
  }
  if (dbName !== DEV_DATABASE) reasons.push(`database is not "${DEV_DATABASE}"`);

  let local = false;
  try {
    const url = new URL(input.appUrl ?? '');
    local = url.protocol === 'http:' && LOCAL_APP_HOSTS.has(url.hostname);
  } catch {
    local = false;
  }
  if (!local) reasons.push('BETTER_AUTH_URL is not http://localhost or http://127.0.0.1');

  // The password is printed once: only to a real terminal, never into a pipe, a log or a chat.
  if (!input.stdoutIsTTY) reasons.push('stdout is not a terminal');
  return reasons;
}
