import { logEvent } from '@/lib/log';
import type { AuditEntry } from '@/server/auth/audit';
import type { Queryable } from '@/server/crypto/subject-keys';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { mailContact } from '@/server/customers/repository';
import { emitEvent } from '@/server/events';
import { sendCollectionMail } from '@/server/mail/adapter';
import { renderForJob } from '@/server/templates/service';
import {
  definitionSchema,
  evaluateConditions,
  type Action,
  type Definition,
  type Facts,
} from './definition';

/**
 * Rule engine (task 3.1) — runs in the worker inside withTenantJob (one tenant, vigor_app).
 *
 *   trigger → facts about the entity → conditions (all, in order, explained) → actions (in order)
 *
 * Deterministic and explainable: every run stores the version, trigger occurrence, the evaluated
 * conditions and each action's outcome. Idempotent: (version, trigger_key, entity) is unique, so
 * the same event or the same local day never runs a version twice on one entity. A run executes
 * in a SAVEPOINT: a failing action rolls back the whole run and records it as failed.
 * Events caused by the engine itself carry payload.source = 'workflow' and never trigger rules
 * (no loops). Rule 19: decisions are only ever proposed; rule 11: the legal handover request is
 * made by a person — the engine proposes it.
 */

type Db = Queryable;
/** Tests pass their keyring; the worker uses PII_MASTER_KEYS (getMasterKeyring). */
export type EngineOptions = { keyring?: MasterKeyring };
type Audit = (entry: AuditEntry) => Promise<void>;

export type Entity = {
  type: 'invoice' | 'customer' | 'case' | 'payment' | 'promise';
  id: string;
  customerId: string;
  invoiceId?: string | null;
  caseId?: string | null;
};

type Version = {
  id: string;
  version: number;
  workflowKey: string;
  workflowName: string;
  definition: Definition;
};

type RunContext = {
  db: Db;
  audit: Audit;
  runId: string;
  versionId: string;
  today: string;
  entity: Entity;
  caseId: string | null;
  facts: Facts & { owner_user: string | null };
  /** 5.1: something overdue of the customer is NOT disputed (customer-level reminders). */
  undisputedOverdue: boolean;
  keyring: () => MasterKeyring;
};

const WORKFLOW = 'workflow';

class ActionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// ---------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------

async function loadFacts(
  db: Db,
  entity: Entity,
): Promise<{
  facts: RunContext['facts'];
  caseId: string | null;
  today: string;
  undisputedOverdue: boolean;
} | null> {
  const { rows } = await db.query<{
    segment: string | null;
    credit_status: string | null;
    country: string | null;
    team: string | null;
    owner: string | null;
    is_natural_person: boolean;
    policy: string | null;
    amount: string | null;
    days_overdue: number | null;
    currency: string | null;
    case_id: string | null;
    case_stage: string | null;
    has_open_dispute: boolean;
    undisputed_overdue: boolean;
    today: string;
  }>(
    `SELECT c.segment_code AS segment, c.credit_status, le.country_code AS country, c.owner_team_id AS team,
            c.owner_user_id AS owner, c.is_natural_person,
            coalesce(c.policy_code, ts.default_policy_code) AS policy,
            CASE WHEN $2::uuid IS NOT NULL THEN inv.open_reporting ELSE agg.overdue END::text AS amount,
            CASE WHEN $2::uuid IS NOT NULL THEN inv.days_overdue ELSE agg.days END AS days_overdue,
            inv.currency, k.id AS case_id, k.stage_code AS case_stage,
            CASE WHEN $2::uuid IS NOT NULL THEN coalesce(inv.is_disputed, false)
                 ELSE EXISTS (SELECT 1 FROM disputes d WHERE d.customer_id = c.id AND d.status IN ('open', 'in_review'))
            END AS has_open_dispute,
            coalesce(agg.undisputed, false) AS undisputed_overdue,
            coalesce(inv.local_today, (SELECT (now() AT TIME ZONE le2.timezone)::date
                                       FROM tenant_companies tc JOIN legal_entities_public le2 ON le2.id = tc.legal_entity_id
                                       ORDER BY tc.is_default DESC, tc.created_at LIMIT 1))::text AS today
     FROM customers c
     CROSS JOIN tenant_settings ts
     LEFT JOIN legal_entities_public le ON le.id = c.legal_entity_id
     LEFT JOIN invoice_positions inv ON inv.invoice_id = $2::uuid
     LEFT JOIN LATERAL (
       SELECT sum(p.open_reporting) FILTER (WHERE p.is_overdue) AS overdue,
              max(p.days_overdue) FILTER (WHERE p.is_overdue) AS days,
              bool_or(p.is_overdue AND NOT p.is_disputed) AS undisputed
       FROM invoice_positions p WHERE p.customer_id = c.id) agg ON true
     LEFT JOIN LATERAL (
       SELECT k.id, k.stage_code FROM collection_cases k
       WHERE k.customer_id = c.id AND k.status = 'open'
         AND ($3::uuid IS NULL OR k.id = $3::uuid)
       ORDER BY (k.id = $3::uuid) DESC NULLS LAST,
                EXISTS (SELECT 1 FROM case_invoices ci WHERE ci.case_id = k.id AND ci.invoice_id = $2::uuid) DESC,
                k.opened_at DESC
       LIMIT 1) k ON true
     WHERE c.id = $1`,
    [entity.customerId, entity.invoiceId ?? null, entity.caseId ?? null],
  );
  const r = rows[0];
  if (!r) return null;
  // 6.1: P0 custom fields — the invoice's first, then the customer's, then the case's (by key).
  const cf = await db.query<{ key: string; value: string | boolean | null }>(
    `SELECT d.key,
            coalesce(to_jsonb(v.value_bool), to_jsonb(coalesce(v.value_text, v.value_numeric::text,
                     v.value_date::text, v.value_option_code)))#>>'{}' AS value
     FROM custom_field_values v JOIN custom_field_definitions d ON d.id = v.field_id
     WHERE d.pii_class = 'P0' AND d.status = 'active'
       AND ((v.entity_type = 'invoice' AND v.entity_id = $2::uuid)
         OR (v.entity_type = 'customer' AND v.entity_id = $1::uuid)
         OR (v.entity_type = 'case' AND v.entity_id = $3::uuid))
     ORDER BY array_position(ARRAY['case', 'customer', 'invoice'], v.entity_type)`,
    [entity.customerId, entity.invoiceId ?? null, r.case_id],
  );
  const custom: Record<string, string | boolean | null> = {};
  // Later rows (invoice) win over earlier ones (customer, case).
  for (const row of cf.rows)
    custom[row.key] = row.value === 'true' ? true : row.value === 'false' ? false : row.value;
  return {
    facts: {
      custom,
      amount: r.amount,
      days_overdue: r.days_overdue,
      segment: r.segment,
      credit_status: r.credit_status,
      country: r.country,
      currency: r.currency,
      team: r.team,
      owner: r.owner,
      case_stage: r.case_stage,
      is_natural_person: r.is_natural_person,
      policy: r.policy,
      has_open_dispute: r.has_open_dispute,
      owner_user: r.owner,
    },
    undisputedOverdue: r.undisputed_overdue,
    caseId: r.case_id,
    today: r.today,
  };
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

async function notify(
  rc: RunContext,
  userIds: (string | null)[],
  messageKey: string,
): Promise<number> {
  const recipients = [...new Set(userIds.filter((u): u is string => Boolean(u)))];
  for (const userId of recipients) {
    await rc.db.query(
      `INSERT INTO notifications (tenant_id, user_id, message_key, customer_id, case_id, source_run_id)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5)`,
      [userId, messageKey, rc.entity.customerId, rc.caseId, rc.runId],
    );
  }
  return recipients.length;
}

async function caseOwner(rc: RunContext): Promise<string | null> {
  if (!rc.caseId) return rc.facts.owner_user;
  const { rows } = await rc.db.query<{ owner: string | null }>(
    'SELECT owner_user_id AS owner FROM collection_cases WHERE id = $1',
    [rc.caseId],
  );
  return rows[0]?.owner ?? rc.facts.owner_user;
}

async function workflowEvent(
  rc: RunContext,
  type: string,
  aggregateType: string,
  id: string,
  payload: Record<string, unknown> = {},
) {
  await emitEvent(rc.db, {
    eventType: type,
    aggregateType,
    aggregateId: id,
    payload: { ...payload, source: WORKFLOW, run_id: rc.runId },
  });
}

type Outcome = { status: 'succeeded' | 'skipped'; result: Record<string, unknown>; error?: string };

async function runAction(rc: RunContext, action: Action): Promise<Outcome> {
  switch (action.type) {
    case 'create_case': {
      if (rc.caseId) {
        if (rc.entity.invoiceId) {
          await rc.db.query(
            `INSERT INTO case_invoices (tenant_id, case_id, invoice_id) VALUES (app_tenant_id(), $1, $2)
             ON CONFLICT (tenant_id, case_id, invoice_id) DO NOTHING`,
            [rc.caseId, rc.entity.invoiceId],
          );
        }
        return { status: 'succeeded', result: { case_id: rc.caseId, existing: true } };
      }
      const { rows } = await rc.db.query<{ id: string }>(
        `INSERT INTO collection_cases (tenant_id, customer_id, owner_user_id, stage_code, priority, workflow_version_id)
         VALUES (app_tenant_id(), $1, $2, 'new', $3, $4) RETURNING id`,
        [rc.entity.customerId, rc.facts.owner_user, action.priority ?? 'normal', rc.versionId],
      );
      const id = rows[0]?.id ?? '';
      await rc.db.query(
        `INSERT INTO case_invoices (tenant_id, case_id, invoice_id)
         SELECT app_tenant_id(), $1, p.invoice_id FROM invoice_positions p
         WHERE p.customer_id = $2 AND p.is_open AND (p.invoice_id = $3::uuid OR ($3::uuid IS NULL AND p.is_overdue))`,
        [id, rc.entity.customerId, rc.entity.invoiceId ?? null],
      );
      rc.caseId = id;
      await rc.audit({
        action: 'case.opened',
        entityType: 'collection_cases',
        entityId: id,
        after: { source: WORKFLOW, run_id: rc.runId },
      });
      await workflowEvent(rc, 'case.opened', 'collection_cases', id, {
        customer_id: rc.entity.customerId,
      });
      return { status: 'succeeded', result: { case_id: id, existing: false } };
    }
    case 'assign': {
      if (!rc.caseId) return { status: 'skipped', result: { reason: 'no_case' } };
      let owner: string | null = null;
      if (action.to === 'customer_owner') owner = rc.facts.owner_user;
      if (action.to === 'user' && action.userId) {
        const u = await rc.db.query<{ id: string }>(
          `SELECT id FROM users WHERE id = $1 AND status = 'active'`,
          [action.userId],
        );
        owner = u.rows[0]?.id ?? null;
      }
      if (action.to === 'team' && action.teamId) {
        const tm = await rc.db.query<{ lead: string | null }>(
          `SELECT lead_user_id AS lead FROM teams WHERE id = $1 AND status = 'active'`,
          [action.teamId],
        );
        owner = tm.rows[0]?.lead ?? null;
      }
      if (!owner) return { status: 'skipped', result: { reason: 'no_assignee' } };
      await rc.db.query('UPDATE collection_cases SET owner_user_id = $2 WHERE id = $1', [
        rc.caseId,
        owner,
      ]);
      await rc.audit({
        action: 'case.updated',
        entityType: 'collection_cases',
        entityId: rc.caseId,
        after: { owner_user_id: owner, source: WORKFLOW },
      });
      await workflowEvent(rc, 'case.assigned', 'collection_cases', rc.caseId, {
        owner_user_id: owner,
      });
      return { status: 'succeeded', result: { case_id: rc.caseId, owner_user_id: owner } };
    }
    case 'create_task': {
      const assignee = await caseOwner(rc);
      const { rows } = await rc.db.query<{ id: string }>(
        `INSERT INTO tasks (tenant_id, customer_id, case_id, assignee_user_id, kind_code, due_on, source_run_id)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5::date + $6::int, $7) RETURNING id`,
        [
          rc.entity.customerId,
          rc.caseId,
          assignee,
          action.kind,
          rc.today,
          action.dueInDays,
          rc.runId,
        ],
      );
      return { status: 'succeeded', result: { task_id: rows[0]?.id, assignee_user_id: assignee } };
    }
    case 'send_notification': {
      let to: string | null = null;
      if (action.to === 'case_owner') to = await caseOwner(rc);
      if (action.to === 'customer_owner') to = rc.facts.owner_user;
      if (action.to === 'team_lead' && rc.facts.team) {
        const tm = await rc.db.query<{ lead: string | null }>(
          'SELECT lead_user_id AS lead FROM teams WHERE id = $1',
          [rc.facts.team],
        );
        to = tm.rows[0]?.lead ?? null;
      }
      const n = await notify(rc, [to], action.message);
      return n
        ? { status: 'succeeded', result: { recipients: n } }
        : { status: 'skipped', result: { reason: 'no_recipient' } };
    }
    case 'queue_email': {
      const tpl = await rc.db.query<{ legal: boolean }>(
        `SELECT has_legal_effect AS legal FROM templates WHERE key = $1 AND channel = 'email' AND status = 'active'`,
        [action.template],
      );
      const t = tpl.rows[0];
      if (!t)
        return {
          status: 'skipped',
          result: { reason: 'template_missing', template: action.template },
        };
      // 5.1: no reminder for a disputed invoice; a customer reminder only while something
      // overdue is NOT disputed.
      if (rc.facts.has_open_dispute && (rc.entity.invoiceId ? true : !rc.undisputedOverdue)) {
        return { status: 'skipped', result: { reason: 'disputed', template: action.template } };
      }
      // Rule 19: a message with legal effect never goes to a natural person automatically.
      if (t.legal && rc.facts.is_natural_person) {
        return { status: 'skipped', result: { reason: 'rule_19', template: action.template } };
      }
      // 3.3: rendered for the customer's mail contact and written to mail_outbox (sink until SMTP
      // exists; a demo tenant always). The run stores ids only — never the address or the text.
      const keyring = rc.keyring();
      const contact = await mailContact(rc.db, keyring, rc.entity.customerId);
      if (!contact)
        return { status: 'skipped', result: { reason: 'no_recipient', template: action.template } };
      const rendered = await renderForJob(
        rc.db,
        {
          key: action.template,
          channel: 'email',
          customerId: rc.entity.customerId,
          invoiceId: rc.entity.invoiceId ?? null,
          locale: contact.language,
        },
        keyring,
      );
      const mail = await sendCollectionMail(rc.db, keyring, {
        kind: rendered.hasLegalEffect ? 'dunning' : 'reminder',
        to: contact.email,
        subject: rendered.subject,
        html: rendered.html,
        customerId: rc.entity.customerId,
        templateId: rendered.templateId,
        sourceRunId: rc.runId,
        caseId: rc.caseId,
      });
      await workflowEvent(rc, 'mail.queued', 'mail_outbox', mail.id, {
        customer_id: rc.entity.customerId,
        template: action.template,
        transport: mail.transport,
      });
      return {
        status: 'succeeded',
        result: {
          mail_id: mail.id,
          template: action.template,
          template_id: rendered.templateId,
          locale: rendered.locale,
          transport: mail.transport,
          contact_id: contact.contactId,
        },
      };
    }
    case 'change_stage': {
      if (!rc.caseId) return { status: 'skipped', result: { reason: 'no_case' } };
      const k = await rc.db.query<{ stage: string }>(
        'SELECT stage_code AS stage FROM collection_cases WHERE id = $1',
        [rc.caseId],
      );
      const from = k.rows[0]?.stage;
      if (from === action.stage)
        return { status: 'skipped', result: { reason: 'already_in_stage' } };
      if (from === 'legal') return { status: 'skipped', result: { reason: 'case_in_legal' } };
      await rc.db.query('UPDATE collection_cases SET stage_code = $2 WHERE id = $1', [
        rc.caseId,
        action.stage,
      ]);
      await rc.audit({
        action: 'case.updated',
        entityType: 'collection_cases',
        entityId: rc.caseId,
        before: { stage_code: from },
        after: { stage_code: action.stage, source: WORKFLOW },
      });
      await workflowEvent(rc, 'case.stage_changed', 'collection_cases', rc.caseId, {
        from,
        to: action.stage,
      });
      return { status: 'succeeded', result: { case_id: rc.caseId, from, to: action.stage } };
    }
    case 'escalate': {
      // Managers = members who may (re)assign cases, plus the lead of the customer's team.
      const { rows } = await rc.db.query<{ id: string }>(
        `SELECT DISTINCT u.id FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id AND p.key = 'case.assign'
         WHERE u.status = 'active'
         UNION
         SELECT t.lead_user_id FROM teams t WHERE t.id = $1 AND t.lead_user_id IS NOT NULL`,
        [rc.facts.team],
      );
      const n = await notify(
        rc,
        rows.map((r) => r.id),
        'rule_escalation',
      );
      return n
        ? { status: 'succeeded', result: { recipients: n } }
        : { status: 'skipped', result: { reason: 'no_recipient' } };
    }
    case 'create_decision':
    case 'create_approval': {
      // Rule 19 / rule 11: a rule only RECOMMENDS. The decision stays 'proposed' until a person
      // approves it; a legal handover request is submitted by a person from the case screen.
      const decisionType =
        action.type === 'create_decision' ? action.decisionType : 'legal_handover';
      const { rows } = await rc.db.query<{ id: string }>(
        `INSERT INTO decisions (tenant_id, customer_id, decision_type, has_legal_effect, source, source_ref, status,
                                case_id, source_run_id)
         VALUES (app_tenant_id(), $1, $2, true, 'rule', $3, 'proposed', $4, $5) RETURNING id`,
        [rc.entity.customerId, decisionType, `workflow_run:${rc.runId}`, rc.caseId, rc.runId],
      );
      await notify(
        rc,
        [await caseOwner(rc)],
        action.type === 'create_decision' ? 'rule_decision_proposed' : 'rule_legal_proposed',
      );
      return {
        status: 'succeeded',
        result: {
          decision_id: rows[0]?.id,
          recommendation: true,
          natural_person: rc.facts.is_natural_person,
        },
      };
    }
    case 'call_webhook': {
      const flag = await rc.db.query<{ enabled: boolean }>(
        `SELECT enabled FROM feature_flags WHERE flag_key = 'workflow.webhooks'`,
      );
      if (!flag.rows[0]?.enabled)
        return { status: 'skipped', result: { reason: 'feature_disabled' } };
      return { status: 'skipped', result: { reason: 'not_implemented' } };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------------------

export type RunOutcome = 'duplicate' | 'skipped' | 'succeeded' | 'failed' | 'no_entity';

export async function runVersion(
  db: Db,
  audit: Audit,
  version: Version,
  trigger: { type: string; key: string; eventId?: string | null },
  entity: Entity,
  opts: EngineOptions = {},
): Promise<RunOutcome> {
  const started = Date.now();
  await db.query('SAVEPOINT workflow_run');
  try {
    const loaded = await loadFacts(db, entity);
    if (!loaded) {
      await db.query('RELEASE SAVEPOINT workflow_run');
      return 'no_entity';
    }
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO workflow_runs (tenant_id, workflow_version_id, trigger_type, trigger_key, event_id, entity_type,
                                  entity_id, customer_id, case_id, status, explanation)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, 'running', '{}')
       ON CONFLICT (tenant_id, workflow_version_id, trigger_key, entity_id) DO NOTHING RETURNING id`,
      [
        version.id,
        trigger.type,
        trigger.key,
        trigger.eventId ?? null,
        entity.type,
        entity.id,
        entity.customerId,
        loaded.caseId,
      ],
    );
    const runId = rows[0]?.id;
    if (!runId) {
      await db.query('RELEASE SAVEPOINT workflow_run');
      return 'duplicate';
    }
    const { ok, results } = evaluateConditions(version.definition.conditions, loaded.facts);
    const explanation = {
      workflow: { key: version.workflowKey, name: version.workflowName },
      version: version.version,
      trigger: version.definition.trigger,
      conditions: results,
      matched: ok,
    };
    const rc: RunContext = {
      db,
      audit,
      runId,
      versionId: version.id,
      today: loaded.today,
      entity,
      caseId: loaded.caseId,
      facts: loaded.facts,
      undisputedOverdue: loaded.undisputedOverdue,
      keyring: () => opts.keyring ?? getMasterKeyring(),
    };
    const actions: { type: string; status: string }[] = [];
    if (ok) {
      for (const [position, action] of version.definition.actions.entries()) {
        const outcome = await runAction(rc, action);
        actions.push({ type: action.type, status: outcome.status });
        await db.query(
          `INSERT INTO workflow_run_actions (tenant_id, run_id, position, action_type, status, result)
           VALUES (app_tenant_id(), $1, $2, $3, $4, $5)`,
          [runId, position, action.type, outcome.status, outcome.result],
        );
      }
    }
    await db.query(
      `UPDATE workflow_runs SET status = $2, explanation = $3, case_id = $4, finished_at = now(), duration_ms = $5
       WHERE id = $1`,
      [
        runId,
        ok ? 'succeeded' : 'skipped',
        { ...explanation, actions },
        rc.caseId,
        Date.now() - started,
      ],
    );
    await db.query('RELEASE SAVEPOINT workflow_run');
    return ok ? 'succeeded' : 'skipped';
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT workflow_run');
    const code =
      error instanceof ActionError
        ? error.code
        : ((error as { code?: string }).code
            ? `sql_${(error as { code: string }).code}`
            : 'unexpected_error'
          ).toLowerCase();
    await db.query(
      `INSERT INTO workflow_runs (tenant_id, workflow_version_id, trigger_type, trigger_key, event_id, entity_type,
                                  entity_id, customer_id, status, explanation, error_code, finished_at, duration_ms)
       VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, 'failed', $8, $9, now(), $10)
       ON CONFLICT (tenant_id, workflow_version_id, trigger_key, entity_id) DO NOTHING`,
      [
        version.id,
        trigger.type,
        trigger.key,
        trigger.eventId ?? null,
        entity.type,
        entity.id,
        entity.customerId,
        {
          workflow: { key: version.workflowKey, name: version.workflowName },
          version: version.version,
          matched: null,
        },
        code.replace(/[^a-z0-9_]/g, '_').slice(0, 60),
        Date.now() - started,
      ],
    );
    await db.query('RELEASE SAVEPOINT workflow_run');
    logEvent('workflow.run_failed', { level: 'error', versionId: version.id, code });
    return 'failed';
  }
}

// ---------------------------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------------------------

async function publishedVersions(db: Db, triggerType: string, event?: string): Promise<Version[]> {
  const { rows } = await db.query<{
    id: string;
    version: number;
    key: string;
    name: string;
    definition: unknown;
  }>(
    `SELECT v.id, v.version, w.key, w.name, v.definition
     FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id
     WHERE v.status = 'published' AND w.status = 'active'
       AND v.definition->'trigger'->>'type' = $1 AND ($2::text IS NULL OR v.definition->'trigger'->>'event' = $2)
     ORDER BY w.key`,
    [triggerType, event ?? null],
  );
  const out: Version[] = [];
  for (const r of rows) {
    const parsed = definitionSchema.safeParse(r.definition);
    if (!parsed.success) {
      logEvent('workflow.definition_invalid', { level: 'error', versionId: r.id });
      continue;
    }
    out.push({
      id: r.id,
      version: r.version,
      workflowKey: r.key,
      workflowName: r.name,
      definition: parsed.data,
    });
  }
  return out;
}

/** Event trigger (worker handler). Events caused by the engine never trigger rules. */
export async function runWorkflowsForEvent(
  db: Db,
  audit: Audit,
  event: {
    id: string;
    eventType: string;
    aggregateId: string | null;
    payload: Record<string, unknown>;
  },
  opts: EngineOptions = {},
): Promise<Record<RunOutcome, number>> {
  const counts: Record<RunOutcome, number> = {
    duplicate: 0,
    skipped: 0,
    succeeded: 0,
    failed: 0,
    no_entity: 0,
  };
  if (!event.aggregateId || event.payload.source === WORKFLOW) return counts;
  const entity = await eventEntity(db, event.eventType, event.aggregateId);
  if (!entity) return counts;
  for (const version of await publishedVersions(db, 'event', event.eventType)) {
    counts[
      await runVersion(
        db,
        audit,
        version,
        { type: event.eventType, key: `event:${event.id}`, eventId: event.id },
        entity,
        opts,
      )
    ] += 1;
  }
  return counts;
}

async function eventEntity(db: Db, type: string, id: string): Promise<Entity | null> {
  const sql: Record<string, string> = {
    'invoice.overdue': `SELECT 'invoice' AS type, id, customer_id, id AS invoice_id, NULL::uuid AS case_id FROM invoices WHERE id = $1`,
    'payment.received': `SELECT 'payment' AS type, id, customer_id, NULL::uuid AS invoice_id, NULL::uuid AS case_id FROM payments WHERE id = $1`,
    'promise.broken': `SELECT 'promise' AS type, id, customer_id, NULL::uuid AS invoice_id, case_id FROM promises WHERE id = $1`,
    'case.stage_changed': `SELECT 'case' AS type, id, customer_id, NULL::uuid AS invoice_id, id AS case_id FROM collection_cases WHERE id = $1`,
  };
  const text = sql[type];
  if (!text) return null;
  const { rows } = await db.query<{
    type: Entity['type'];
    id: string;
    customer_id: string;
    invoice_id: string | null;
    case_id: string | null;
  }>(text, [id]);
  const r = rows[0];
  return r
    ? {
        type: r.type,
        id: r.id,
        customerId: r.customer_id,
        invoiceId: r.invoice_id,
        caseId: r.case_id,
      }
    : null;
}

/**
 * Daily triggers (tenant-local, after 06:00 — runTenantDaily). Trigger keys are LOCAL dates (or
 * the start of an inactivity streak), so a second run on the same local day — a DST double
 * tick, a retry — finds the run already there.
 */
export async function runDailyWorkflows(
  db: Db,
  audit: Audit,
  opts: EngineOptions = {},
): Promise<Record<RunOutcome, number>> {
  const counts: Record<RunOutcome, number> = {
    duplicate: 0,
    skipped: 0,
    succeeded: 0,
    failed: 0,
    no_entity: 0,
  };
  const add = (o: RunOutcome) => (counts[o] += 1);

  for (const version of await publishedVersions(db, 'days_from_due')) {
    const t = version.definition.trigger;
    if (t.type !== 'days_from_due') continue;
    const { rows } = await db.query<{ invoice_id: string; customer_id: string; today: string }>(
      t.businessDays
        ? `SELECT p.invoice_id, p.customer_id, p.local_today::text AS today FROM invoice_positions p
           WHERE p.is_open AND sign(p.local_today - p.due_date) = sign($1::int)
             AND (SELECT count(*) FROM generate_series(least(p.due_date, p.local_today) + 1,
                                                       greatest(p.due_date, p.local_today), interval '1 day') g(d)
                  WHERE extract(isodow FROM g.d) < 6) = abs($1::int)`
        : `SELECT p.invoice_id, p.customer_id, p.local_today::text AS today FROM invoice_positions p
           WHERE p.is_open AND p.due_date + $1::int = p.local_today`,
      [t.offset],
    );
    for (const r of rows) {
      add(
        await runVersion(
          db,
          audit,
          version,
          { type: 'days_from_due', key: `day:${r.today}` },
          { type: 'invoice', id: r.invoice_id, customerId: r.customer_id, invoiceId: r.invoice_id },
          opts,
        ),
      );
    }
  }

  for (const version of await publishedVersions(db, 'no_activity')) {
    const t = version.definition.trigger;
    if (t.type !== 'no_activity') continue;
    const { rows } = await db.query<{ customer_id: string; since: string }>(
      `SELECT p.customer_id, coalesce(max(a.occurred_at)::date::text, 'never') AS since
       FROM invoice_positions p LEFT JOIN activities a ON a.customer_id = p.customer_id
       WHERE p.is_overdue
       GROUP BY p.customer_id
       HAVING coalesce(max(a.occurred_at), '-infinity') < now() - make_interval(days => $1::int)`,
      [t.days],
    );
    for (const r of rows) {
      // One run per inactivity streak: the key is the date of the last activity.
      add(
        await runVersion(
          db,
          audit,
          version,
          { type: 'no_activity', key: `noact:${r.since}` },
          { type: 'customer', id: r.customer_id, customerId: r.customer_id },
          opts,
        ),
      );
    }
  }

  for (const version of await publishedVersions(db, 'specific_date')) {
    const t = version.definition.trigger;
    if (t.type !== 'specific_date') continue;
    const { rows } = await db.query<{ customer_id: string }>(
      `SELECT DISTINCT p.customer_id FROM invoice_positions p WHERE p.is_open AND p.local_today = $1::date`,
      [t.date],
    );
    for (const r of rows) {
      add(
        await runVersion(
          db,
          audit,
          version,
          { type: 'specific_date', key: `date:${t.date}` },
          { type: 'customer', id: r.customer_id, customerId: r.customer_id },
          opts,
        ),
      );
    }
  }
  return counts;
}
