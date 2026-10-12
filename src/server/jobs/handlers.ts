import { logEvent } from '@/lib/log';
import { getMasterKeyring } from '@/server/crypto/keyring';
import { applyImport } from '@/server/imports/process';
import { EVENT_TRIGGERS } from '@/server/workflows/definition';
import { runWorkflowsForEvent } from '@/server/workflows/engine';
import type { EventHandlers } from './outbox';

/**
 * Domain event handlers, by event_type. Each runs inside withTenantJob(event.tenant_id) as
 * vigor_app and must be idempotent (key = event id). Business reactions (reminders, risk
 * recalculation) arrive with their sprints; until then events are acknowledged.
 */
// 3.1: rule engine — every event a workflow can be triggered by.
const WORKFLOW_HANDLERS: EventHandlers = Object.fromEntries(
  EVENT_TRIGGERS.map((type) => [
    type,
    async (ctx, event) => {
      const counts = await runWorkflowsForEvent(ctx.db, ctx.audit, event);
      logEvent('workflow.event_handled', { tenantId: ctx.tenantId, eventId: event.id, ...counts });
    },
  ]),
);

export const EVENT_HANDLERS: EventHandlers = {
  ...WORKFLOW_HANDLERS,
  // 1.5: settings changed → nothing to recompute yet; the event is the audit trail for jobs.
  'tenant_settings.updated': async (ctx, event) => {
    logEvent('tenant_settings.updated.handled', { tenantId: ctx.tenantId, eventId: event.id });
  },
  // 2.2: a confirmed import run is applied in one transaction; redelivery is a no-op.
  'import.confirmed': async (ctx, event) => {
    if (!event.aggregateId) return;
    const result = await applyImport(ctx.db, ctx.audit, getMasterKeyring(), ctx.tenantId, event.aggregateId);
    logEvent('import.applied', { tenantId: ctx.tenantId, eventId: event.id, result });
  },
};
