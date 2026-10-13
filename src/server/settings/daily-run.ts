import type { TenantContext } from '@/server/auth/with-tenant';
import { emitEvent } from '@/server/events';

/**
 * "Run the daily job now" (3.3, Admin → System status): the same tenant work as the 06:00 run,
 * requested through the outbox — the worker runs it inside withTenantJob (handler
 * tenant.daily_requested). Safe to press twice: every step is idempotent (promise evaluation,
 * one invoice.overdue per invoice, one rule run per version + local day + entity).
 */
export async function requestDailyRun(ctx: TenantContext): Promise<{ eventId: string }> {
  await ctx.requirePermission('settings.manage');
  const eventId = await emitEvent(ctx.db, {
    eventType: 'tenant.daily_requested',
    aggregateType: 'tenants',
    aggregateId: ctx.tenantId,
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  await ctx.audit({
    action: 'tenant.daily_requested',
    entityType: 'tenants',
    entityId: ctx.tenantId,
    after: { event_id: eventId },
  });
  return { eventId };
}
