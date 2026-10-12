import { betterAuth, BASE_ERROR_CODES, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { Pool } from 'pg';
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
 * - The session carries `activeTenantId` from public.users — the ONLY tenant source for
 *   withTenant() (task 1.2).
 */

export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const MAX_FAILED_SIGN_INS = 5;
export const LOCKOUT_SECONDS = 15 * 60;
const MIN_PASSWORD_LENGTH = 12;

export type AuthConfig = {
  /** vigor_app connection string; the auth pool pins search_path to schema `auth`. */
  connectionString: string;
  /** BETTER_AUTH_SECRET — signs cookies, encrypts TOTP secrets. Never logged. */
  secret: string;
  /** Public origin, e.g. https://app.example.com (BETTER_AUTH_URL). */
  baseURL: string;
  /** Product name shown in the authenticator app (rule 21). */
  issuer: string;
  /** false only in tests over plain HTTP. */
  secureCookies?: boolean;
  /** Outgoing auth mail (password reset). Task 1.1b wires the email service + demo sink. */
  mailer?: AuthMailer;
};

export type AuthMail = { kind: 'password_reset'; to: string; url: string };
export type AuthMailer = (mail: AuthMail) => Promise<void>;

// TODO(1.1b): email service with the demo-tenant sink (rule 24). Until then nothing is sent.
const noMailer: AuthMailer = async () => {};

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

export function buildAuthOptions(config: AuthConfig, pool: Pool) {
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
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await (config.mailer ?? noMailer)({ kind: 'password_reset', to: user.email, url });
      },
    },
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
      useSecureCookies: config.secureCookies ?? true,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: config.secureCookies ?? true,
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
        if (ctx.path !== '/sign-in/email') return;
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

let instance: Auth | undefined;

/** Runtime instance from the environment. Fails without printing any secret. */
export function getAuth(): Auth {
  if (instance) return instance;
  const { DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, PRODUCT_NAME } = process.env;
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  if (!BETTER_AUTH_SECRET || BETTER_AUTH_SECRET.length < 32) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set or shorter than 32 characters (docs/runbook.md).',
    );
  }
  if (!BETTER_AUTH_URL) throw new Error('BETTER_AUTH_URL is not set.');
  instance = createAuth({
    connectionString: DATABASE_URL,
    secret: BETTER_AUTH_SECRET,
    baseURL: BETTER_AUTH_URL,
    issuer: PRODUCT_NAME || 'App',
  });
  return instance;
}
