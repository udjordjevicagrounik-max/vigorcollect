# src/server/auth — PROTECTED (CLAUDE.md rule 13)

Claude proposes changes here and stops; a human reviews and commits. No custom auth — Better
Auth is the identity provider (rule 10, ADR 0004).

- `better-auth.ts` — Better Auth configuration: schema `auth`, password + mandatory TOTP,
  8 h absolute session, lockout hooks (5 / 15 min), per-IP rate limit, `activeTenantId`.
- `memberships.ts` — a verified person's tenant memberships (`app.auth_user_id` policy, 005; pre-tenant only).
- `session.ts` — `getAuthContext()`: the only source of the tenant for `withTenant()`.
- Task 1.2: `withTenant()`, `requirePermission()`, `audit()`.
