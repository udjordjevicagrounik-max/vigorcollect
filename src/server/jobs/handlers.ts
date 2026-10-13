import { logEvent } from '@/lib/log';
import { runDailyCollections } from '@/server/collections/service';
import { getMasterKeyring } from '@/server/crypto/keyring';
import { chromiumPath } from '@/server/documents/pdf';
import { renderDocumentPdf } from '@/server/documents/service';
import { applyImport } from '@/server/imports/process';
import { fanOut, OUTBOUND_EVENT_TYPES } from '@/server/integrations/outbound';
import { processWebhookEvent, registerWebhookHandler } from '@/server/integrations/process';
import { handleMailReceived, handleMailStatus } from '@/server/mail/inbox';
import { EVENT_TRIGGERS } from '@/server/workflows/definition';
import { runDailyWorkflows, runWorkflowsForEvent } from '@/server/workflows/engine';
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

// 3.3: job document.render_pdf — the PDF of a generated document, in this (worker) process only.
// Without Chromium (a host without the worker image) the event is acknowledged and logged; the
// document can be re-requested later (document.render_requested).
const renderPdfHandler: EventHandlers[string] = async (ctx, event) => {
  if (!event.aggregateId) return;
  if (!chromiumPath()) {
    logEvent('document.pdf_unavailable', {
      level: 'warn',
      tenantId: ctx.tenantId,
      documentId: event.aggregateId,
    });
    return;
  }
  const outcome = await renderDocumentPdf(ctx.db, ctx.audit, getMasterKeyring(), event.aggregateId);
  logEvent('document.render_pdf.handled', { tenantId: ctx.tenantId, eventId: event.id, outcome });
};

const BASE_HANDLERS: EventHandlers = {
  ...WORKFLOW_HANDLERS,
  'document.generated': renderPdfHandler,
  'document.render_requested': renderPdfHandler,
  // 3.3: Admin → System status "run the daily job now" — the same work as the 06:00 run
  // (runTenantDaily). Idempotent: promises are evaluated once, invoice.overdue is emitted once
  // per invoice, and rule runs are unique per (version, local day, entity).
  'tenant.daily_requested': async (ctx, event) => {
    const result = await runDailyCollections(ctx.db, ctx.audit);
    const runs = await runDailyWorkflows(ctx.db, ctx.audit);
    logEvent('tenant.daily', {
      tenantId: ctx.tenantId,
      eventId: event.id,
      manual: true,
      ...result,
      workflowRuns: runs.succeeded + runs.skipped + runs.failed,
      workflowFailed: runs.failed,
    });
  },
  // 1.5: settings changed → nothing to recompute yet; the event is the audit trail for jobs.
  'tenant_settings.updated': async (ctx, event) => {
    logEvent('tenant_settings.updated.handled', { tenantId: ctx.tenantId, eventId: event.id });
  },
  // 2.2: a confirmed import run is applied in one transaction; redelivery is a no-op.
  'import.confirmed': async (ctx, event) => {
    if (!event.aggregateId) return;
    const result = await applyImport(
      ctx.db,
      ctx.audit,
      getMasterKeyring(),
      ctx.tenantId,
      event.aggregateId,
    );
    logEvent('import.applied', { tenantId: ctx.tenantId, eventId: event.id, result });
  },
};

// 4.2: inbound mail types of the n8n mailbox integration.
registerWebhookHandler('mail.received', handleMailReceived);
registerWebhookHandler('mail.status', handleMailStatus);

// 4.1: inbound webhooks are processed here (never in the request), outbound subscriptions fan out.
// A subscribable event keeps its own handler (rules, PDF …) and additionally gets one delivery
// per integration that subscribed to it.
const withFanOut = (type: string): EventHandlers[string] => {
  const own = BASE_HANDLERS[type];
  return async (ctx, event) => {
    if (own) await own(ctx, event);
    const n = await fanOut(ctx.db, event);
    if (n)
      logEvent('outbound.queued', { tenantId: ctx.tenantId, eventId: event.id, deliveries: n });
  };
};

export const EVENT_HANDLERS: EventHandlers = {
  ...BASE_HANDLERS,
  ...Object.fromEntries(OUTBOUND_EVENT_TYPES.map((type) => [type, withFanOut(type)])),
  'webhook.received': async (ctx, event) => {
    if (!event.aggregateId) return;
    const outcome = await processWebhookEvent(
      ctx.db,
      ctx.audit,
      getMasterKeyring(),
      event.aggregateId,
    );
    logEvent('webhook.handled', { tenantId: ctx.tenantId, eventId: event.id, outcome });
  },
};
