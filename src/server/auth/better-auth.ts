import { betterAuth, BASE_ERROR_CODES, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { Pool } from 'pg';
import { HONEYPOT_FIELD, MIN_PASSWORD_LENGTH } from '@/lib/auth-policy';
import { getMasterKeyring } from '@/server/crypto/keyring';
import { createAuthMailer } from '@/server/mail/auth-mailer';
import { activeMemberships, isMember } from './memberships';

/**
 * Better Auth configuration (rule 10: no custom auth — only Better Auth options, plugins and
 * hooks). ADR 0004.
 *
 * - Tables live in schema `auth` (global person identity, no tenant RLS — ADR 0002 "Otvoreno" 1);
 *   `public.users.auth_user_id` links a person to tenant memberships.
 * - Email + password, TOTP mandatory (enforced by getAuthContext: no tenant access before MFA).
 * - Session 8 h absolute (no sliding refresh); a new token on every sign-in / MFA verification.
 * - Password lockout: 5 failures → 15 min, through Better Auth hooks; the answer while locked is
 *   identical to a wrong password (rule 27). TOTP lockout: the two-factor plugin, same limits.
 * - Rate limit per IP, stored in the database (shared by all app instances).
 * - One-time tokens (password reset) are stored hashed (`verification.storeIdentifier`); the
 *   plaintext exists only in the e-mail. A password change always revokes the other sessions.
 * - Secure cookie always, except a non-production run on http://localhost / http://127.0.0.1
 *   (resolveSecureCookies) — there is no flag that turns it off.
 * - The session carries `activeTenantId` from public.users — the ONLY tenant source for
 *   withTenant() (task 1.2).
 */

export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const MAX_FAILED_SIGN_INS = 5;
export const LOCKOUT_SECONDS = 15 * 60;

export type AuthConfig = {
  /** vigor_app connection string; the auth pool pins search_path to schema `auth`. */
  connectionString: string;
  /** BETTER_AUTH_SECRET — signs cookies, encrypts TOTP secrets. Never logged. */
  secret: string;
  /** Public origin, e.g. https://app.example.com (BETTER_AUTH_URL). */
  baseURL: string;
  /** Product name shown in the authenticator app (rule 21). */
  issuer: string;
  /** Outgoing auth mail (password reset) — src/server/mail/auth-mailer.ts at runtime. */
  mailer?: AuthMailer;
};

export type AuthMail = { kind: 'password_reset'; to: string; url: string; authUserId: string };
export type AuthMailer = (mail: AuthMail) => Promise<void>;

const noMailer: AuthMailer = async () => {};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Secure cookies are on unless BOTH hold: NODE_ENV is not 'production' AND the public URL is plain
 * http on localhost / 127.0.0.1 (decision after 1.1a, NEXT.md). No environment flag can turn
 * them off; anything unparsable counts as remote → secure.
 */
export function resolveSecureCookies(nodeEnv: string | undefined, baseURL: string): boolean {
  if (nodeEnv === 'production') return true;
  try {
    const url = new URL(baseURL);
    return !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  } catch {
    return true;
  }
}

type LockoutFields = {
  id: string;
  failedSignInCount?: number | null;
  signInLockedUntil?: Date | string | null;
};

function lockedUntil(user: LockoutFields): number {
  return user.signInLockedUntil ? new Date(user.signInLockedUntil).getTime() : 0;
}

function signInEmail(body: unknown): string | undefined {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : undefined;
}

export function honeypotFilled(body: unknown): boolean {
  const value = (body as Record<string, unknown> | undefined)?.[HONEYPOT_FIELD];
  return typeof value === 'string' && value.trim() !== '';
}

export function buildAuthOptions(config: AuthConfig, pool: Pool) {
  const secureCookies = resolveSecureCookies(process.env.NODE_ENV, config.baseURL);
  return {
    appName: config.issuer,
    baseURL: config.baseURL,
    basePath: '/api/auth',
    secret: config.secret,
    database: pool,
    emailAndPassword: {
      enabled: true,
      // Accounts are created by invitation only (task 1.1b), never by public sign-up.
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      // Same response whether the account exists or not (rule 27) — Better Auth's own behavior.
      sendResetPassword: async ({
        user,
        url,
      }: {
        user: { id: string; email: string };
        url: string;
      }) => {
        await (config.mailer ?? noMailer)({
          kind: 'password_reset',
          to: user.email,
          url,
          authUserId: user.id,
        });
      },
    },
    // Reset (and other one-time) tokens: only a hash is stored (ADR 0004, 1.1b).
    verification: { storeIdentifier: 'hashed' },
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      // Absolute lifetime: never extended by activity.
      disableSessionRefresh: true,
      additionalFields: {
        // Set from public.users memberships; validated on every write (databaseHooks).
        activeTenantId: { type: 'string', required: false, input: true },
      },
    },
    user: {
      additionalFields: {
        failedSignInCount: {
          type: 'number',
          required: false,
          defaultValue: 0,
          input: false,
          returned: false,
        },
        signInLockedUntil: { type: 'date', required: false, input: false, returned: false },
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/two-factor/verify-totp': { window: 60, max: 10 },
        '/two-factor/verify-backup-code': { window: 60, max: 10 },
        '/request-password-reset': { window: 300, max: 5 },
        '/reset-password': { window: 300, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: secureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: secureCookies,
        sameSite: 'lax',
      },
      database: { generateId: 'uuid' },
    },
    databaseHooks: {
      session: {
        create: {
          // Exactly one active membership → bind it; several → the user picks (update-session).
          before: async (session: { userId: string; activeTenantId?: string | null }) => {
            const memberships = await activeMemberships(pool, session.userId);
            const only = memberships.length === 1 ? memberships[0]?.tenantId : undefined;
            return { data: { ...session, activeTenantId: only ?? null } };
          },
        },
        update: {
          before: async (session: { userId?: string; activeTenantId?: string | null }, ctx) => {
            if (session.activeTenantId === undefined || session.activeTenantId === null) return;
            const userId = session.userId ?? ctx?.context.session?.user.id;
            if (!userId || !(await isMember(pool, userId, session.activeTenantId))) {
              throw new APIError('FORBIDDEN', { message: 'Tenant is not available.' });
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // A changed password ends every other session, whatever the client asked for.
        if (ctx.path === '/change-password') {
          return { context: { body: { ...(ctx.body as object), revokeOtherSessions: true } } };
        }
        if (ctx.path !== '/sign-in/email') return;
        // Honeypot (rule 27): a hidden form field people never fill. Same answer as a wrong
        // password, same work, nothing counted against the account.
        if (honeypotFilled(ctx.body)) {
          await ctx.context.password.hash('honeypot');
          throw APIError.from('UNAUTHORIZED', BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
        }
        const email = signInEmail(ctx.body);
        if (!email) return;
        const found = await ctx.context.internalAdapter.findUserByEmail(email);
        const user = found?.user as LockoutFields | undefined;
        if (user && lockedUntil(user) > Date.now()) {
          // Same work and same answer as a wrong password: no "account locked" signal (rule 27).
          const password = (ctx.body as { password?: unknown }).password;
          await ctx.context.password.hash(typeof password === 'string' ? password : '');
          throw APIError.from('UNAUTHORIZED', BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const email = signInEmail(ctx.body);
        if (!email) return;
        const found = await ctx.context.internalAdapter.findUserByEmail(email);
        const user = found?.user as LockoutFields | undefined;
        if (!user) return;
        const returned = ctx.context.returned;
        if (isAPIError(returned)) {
          if (
            (returned.body as { code?: string } | undefined)?.code !== 'INVALID_EMAIL_OR_PASSWORD'
          )
            return;
          const failures = (user.failedSignInCount ?? 0) + 1;
          await ctx.context.internalAdapter.updateUser(
            user.id,
            failures >= MAX_FAILED_SIGN_INS
              ? {
                  failedSignInCount: 0,
                  signInLockedUntil: new Date(Date.now() + LOCKOUT_SECONDS * 1000),
                }
              : { failedSignInCount: failures },
          );
          return;
        }
        // Correct password (session or MFA challenge): the counter starts over.
        if ((user.failedSignInCount ?? 0) > 0 || user.signInLockedUntil) {
          await ctx.context.internalAdapter.updateUser(user.id, {
            failedSignInCount: 0,
            signInLockedUntil: null,
          });
        }
      }),
    },
    plugins: [
      twoFactor({
        issuer: config.issuer,
        accountLockout: {
          enabled: true,
          maxFailedAttempts: MAX_FAILED_SIGN_INS,
          durationSeconds: LOCKOUT_SECONDS,
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuthPool(connectionString: string): Pool {
  return new Pool({ connectionString, options: '-c search_path=auth' });
}

export function createAuth(
  config: AuthConfig,
  pool: Pool = createAuthPool(config.connectionString),
) {
  return betterAuth(buildAuthOptions(config, pool));
}

export type Auth = ReturnType<typeof createAuth>;

type Runtime = { auth: Auth; authPool: Pool; appPool: Pool; baseURL: string };
let runtime: Runtime | undefined;

/** Runtime instance from the environment. Fails without printing any secret. */
function getRuntime(): Runtime {
  if (runtime) return runtime;
  const { DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, PRODUCT_NAME } = process.env;
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  if (!BETTER_AUTH_SECRET || BETTER_AUTH_SECRET.length < 32) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set or shorter than 32 characters (docs/runbook.md).',
    );
  }
  if (!BETTER_AUTH_URL) throw new Error('BETTER_AUTH_URL is not set.');
  // auth pool: search_path=auth (Better Auth tables); app pool: public schema (mail, invitations).
  const authPool = createAuthPool(DATABASE_URL);
  const appPool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const auth = createAuth(
    {
      connectionString: DATABASE_URL,
      secret: BETTER_AUTH_SECRET,
      baseURL: BETTER_AUTH_URL,
      issuer: PRODUCT_NAME || 'App',
      mailer: createAuthMailer({ pool: appPool, keyring: getMasterKeyring }),
    },
    authPool,
  );
  runtime = { auth, authPool, appPool, baseURL: BETTER_AUTH_URL };
  return runtime;
}

export function getAuth(): Auth {
  return getRuntime().auth;
}

/** vigor_app pool with search_path=auth — for getAuthContext() / memberships. */
export function getAuthPool(): Pool {
  return getRuntime().authPool;
}

/** vigor_app pool (public schema) used by the auth flows (invitations, mail). */
export function getAuthAppPool(): Pool {
  return getRuntime().appPool;
}

export function getAuthBaseURL(): string {
  return getRuntime().baseURL;
}
