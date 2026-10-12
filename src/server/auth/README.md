# src/server/auth — PROTECTED (CLAUDE.md rule 13)

Claude proposes changes here and stops; a human reviews and commits. No custom auth — Better
Auth is the identity provider (rule 10, ADR 0004).

- `better-auth.ts` — Better Auth configuration: schema `auth`, password + mandatory TOTP,
  8 h absolute session, lockout hooks (5 / 15 min), per-IP rate limit, `activeTenantId`,
  hashed one-time tokens, honeypot, password change ends other sessions, secure-cookie rule.
- `memberships.ts` — a verified person's tenant memberships (`app.auth_user_id` policy, 005; pre-tenant only).
- `session.ts` — `getAuthContext()`: the only source of the tenant for `withTenant()`.
- `context.ts` — `currentAuthContext()` / `requireTenantSession()` for pages (next step routing).
- `invitations.ts` — one-time invitations (hash only, 72 h), acceptance → identity + users row +
  role + audit (1.1b, migration 006).
- `with-tenant.ts` — `withTenant()`: tenant only from the session, SET LOCAL app.tenant_id,
  RESET app.auth_user_id, fail closed without `requirePermission()` / mutation without `audit()`,
  403 / 404 / 409 / 400 / 500 mapping, X-Request-Id + X-App-Version (1.2).
- `permissions.ts` — `requirePermission()`: role_permissions × user_roles.scope (widest scope).
- `audit.ts` — `audit()` / `writeAudit()`: request id + tenant, snapshots redacted through
  pii_field_registry (only plain P0 columns survive).
