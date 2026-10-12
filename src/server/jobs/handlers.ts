import { logEvent } from '@/lib/log';
import type { EventHandlers } from './outbox';

/**
 * Domain event handlers, by event_type. Each runs inside withTenantJob(event.tenant_id) as
 * vigor_app and must be idempotent (key = event id). Business reactions (reminders, risk
 * recalculation) arrive with their sprints; until then events are acknowledged.
 */
export const EVENT_HANDLERS: EventHandlers = {
  // 1.5: settings changed → nothing to recompute yet; the event is the audit trail for jobs.
  'tenant_settings.updated': async (ctx, event) => {
    logEvent('tenant_settings.updated.handled', { tenantId: ctx.tenantId, eventId: event.id });
  },
};
