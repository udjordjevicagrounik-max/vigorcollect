import { z } from 'zod';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { scopeFilter } from '@/server/auth/scope';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { requestLegalHandover } from '@/server/collections/service';
import { emitEvent } from '@/server/events';

/**
 * Rule proposals → a person (task 3.3; rules 11 and 19). A rule only RECOMMENDS: the engine
 * writes decisions (source 'rule', status 'proposed') and the proposal shows up in "Zahteva
 * pažnju". A member submits it:
 *   - legal handover → the existing maker-checker request 'case.legal_handover' for the case
 *     (approval.create; checker approval.legal_handover); for a natural person that flow also
 *     records the human decision (rule 19);
 *   - any other decision → approval_request 'decision.approve' (maker decision.create; checker
 *     decision.approve, never the maker — service + approval_requests_four_eyes).
 * The proposal is linked to the request (decisions.approval_request_id) and follows its outcome:
 * approved by the checker (approved_by = a person) or rejected.
 */

export const DECISION_APPROVAL_ACTION = 'decision.approve';
const LEGAL = 'legal_handover';

export type RuleProposal = {
  id: string;
  customerId: string;
  customerName: string | null;
  caseId: string | null;
  decisionType: string;
  naturalPerson: boolean;
  createdAt: string;
};

/** Open rule proposals within the member's scope (attention list). */
export async function listRuleProposals(
  ctx: TenantContext,
  scope: Parameters<typeof scopeFilter>[1]['scope'],
  limit = 20,
): Promise<RuleProposal[]> {
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{
    id: string;
    customer_id: string;
    customer_name: string | null;
    case_id: string | null;
    decision_type: string;
    is_natural_person: boolean;
    created_at: Date;
  }>(
    `SELECT d.id, d.customer_id, c.display_name AS customer_name, d.case_id, d.decision_type,
            c.is_natural_person, d.created_at
     FROM decisions d JOIN customers c ON c.id = d.customer_id AND ${filter.sql}
     WHERE d.source = 'rule' AND d.status = 'proposed' AND d.approval_request_id IS NULL
     ORDER BY d.created_at DESC LIMIT $1`,
    [limit, ...filter.params],
  );
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    caseId: r.case_id,
    decisionType: r.decision_type,
    naturalPerson: r.is_natural_person,
    createdAt: r.created_at.toISOString(),
  }));
}

/** Maker: submits a rule proposal for approval. Out of scope or already submitted: 404 / 409. */
export async function submitRuleProposal(
  ctx: TenantContext,
  decisionId: string,
): Promise<{ approvalId: string }> {
  const found = await ctx.db.query<{ decision_type: string }>(
    `SELECT decision_type FROM decisions WHERE id = $1 AND source = 'rule'`,
    [decisionId],
  );
  const type = found.rows[0]?.decision_type;
  const { scope } = await ctx.requirePermission(
    type === LEGAL ? 'approval.create' : 'decision.create',
  );
  if (!type) throw new NotFoundError();
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{
    customer_id: string;
    case_id: string | null;
    status: string;
    approval_request_id: string | null;
    source_ref: string | null;
    is_natural_person: boolean;
  }>(
    `SELECT d.customer_id, d.case_id, d.status, d.approval_request_id, d.source_ref, c.is_natural_person
     FROM decisions d JOIN customers c ON c.id = d.customer_id AND ${filter.sql}
     WHERE d.id = $1 FOR UPDATE OF d`,
    [decisionId, ...filter.params],
  );
  const d = rows[0];
  if (!d) throw new NotFoundError();
  if (d.status !== 'proposed' || d.approval_request_id) throw new ConflictError('conflict');

  let approvalId: string;
  if (type === LEGAL) {
    if (!d.case_id) throw new ConflictError('conflict');
    ({ approvalId } = await requestLegalHandover(ctx, d.case_id, {
      reason: d.source_ref ?? 'workflow',
    }));
  } else {
    const pending = await ctx.db.query(
      `SELECT 1 FROM approval_requests WHERE action_type = $1 AND entity_id = $2 AND status = 'pending'`,
      [DECISION_APPROVAL_ACTION, decisionId],
    );
    if (pending.rowCount) throw new ConflictError('conflict');
    const ins = await ctx.db.query<{ id: string }>(
      `INSERT INTO approval_requests (tenant_id, action_type, entity_type, entity_id, payload, requested_by,
                                      request_id, created_by)
       VALUES (app_tenant_id(), $1, 'decisions', $2,
               jsonb_build_object('customer_id', $3::uuid, 'decision_type', $4::text,
                                  'natural_person', $5::boolean, 'case_id', $6::uuid),
               $7, $8, $7) RETURNING id`,
      [
        DECISION_APPROVAL_ACTION,
        decisionId,
        d.customer_id,
        type,
        d.is_natural_person,
        d.case_id,
        ctx.userId,
        ctx.requestId,
      ],
    );
    approvalId = ins.rows[0]?.id ?? '';
    await ctx.audit({
      action: 'approval_request.created',
      entityType: 'approval_requests',
      entityId: approvalId,
      after: {
        action_type: DECISION_APPROVAL_ACTION,
        entity_type: 'decisions',
        entity_id: decisionId,
        status: 'pending',
      },
    });
  }
  await ctx.db.query(
    `UPDATE decisions SET approval_request_id = $2, updated_by = $3 WHERE id = $1 AND status = 'proposed'`,
    [decisionId, approvalId, ctx.userId],
  );
  await ctx.audit({
    action: 'decision.submitted',
    entityType: 'decisions',
    entityId: decisionId,
    after: { approval_request_id: approvalId, decision_type: type },
  });
  await emitEvent(ctx.db, {
    eventType: 'decision.submitted',
    aggregateType: 'decisions',
    aggregateId: decisionId,
    payload: { approval_id: approvalId, decision_type: type, customer_id: d.customer_id },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { approvalId };
}

export const decisionApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
});

/** Checker side of 'decision.approve'; routed from approvals/service decideApproval(). */
export async function decideDecisionApproval(
  ctx: TenantContext,
  approvalId: string,
  input: z.input<typeof decisionApprovalSchema>,
): Promise<{ status: 'approved' | 'rejected' }> {
  await ctx.requirePermission('decision.approve');
  const { decision, note } = decisionApprovalSchema.parse(input);
  if (decision === 'reject' && !note) throw new ConflictError('invalid_request');
  const { rows } = await ctx.db.query<{ status: string; requested_by: string; entity_id: string }>(
    `SELECT status, requested_by, entity_id FROM approval_requests WHERE id = $1 AND action_type = $2 FOR UPDATE`,
    [approvalId, DECISION_APPROVAL_ACTION],
  );
  const req = rows[0];
  if (!req) throw new NotFoundError();
  if (req.status !== 'pending') throw new ConflictError('not_pending');
  if (req.requested_by === ctx.userId) throw new PermissionDeniedError();
  const status = decision === 'approve' ? 'approved' : 'rejected';
  await ctx.db.query(
    `UPDATE approval_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
            updated_by = $3 WHERE id = $1`,
    [approvalId, status, ctx.userId, note ?? null],
  );
  // Rule 19: the decision becomes 'approved' only with a person as approver.
  await ctx.db.query(
    `UPDATE decisions SET status = $2, approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid END,
            approved_at = CASE WHEN $2 = 'approved' THEN now() END, updated_by = $3
     WHERE approval_request_id = $1 AND status = 'proposed'`,
    [approvalId, status, ctx.userId],
  );
  await ctx.audit({
    action: `approval_request.${status}`,
    entityType: 'approval_requests',
    entityId: approvalId,
    before: { status: 'pending' },
    after: { status },
  });
  await emitEvent(ctx.db, {
    eventType: `decision.${status}`,
    aggregateType: 'decisions',
    aggregateId: req.entity_id,
    payload: { approval_id: approvalId },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { status };
}
