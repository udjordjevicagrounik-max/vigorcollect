# src/server

API routes and domain services. Every route: `withTenant()` → `requirePermission('object.action')`
→ Zod validation → service → `audit()` (+ `domain_events` when something is triggered).

```ts
export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  const { scope } = await ctx.requirePermission('user.update'); // 403 without detail
  // ctx.db is inside the tenant transaction (RLS); another tenant's id → throw NotFoundError()
  await ctx.audit({ action: 'user.updated', entityType: 'users', entityId: params.id, after });
  return NextResponse.json({ ok: true });
});
```

Golden: `tests/golden/api-routes.test.ts` (no route without the two calls, unless it is in
`docs/permissions.md` „Javne rute"), `tests/golden/db/tenant-api.test.ts` (session-only tenant,
403, IDOR → 404, audit per mutation, redaction).
See CLAUDE.md, NON-NEGOTIABLE rules 1–12.
