import { NextResponse, type NextRequest } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import {
  disputeListQuery,
  listDisputes,
  newDisputeSchema,
  openDispute,
} from '@/server/disputes/service';

export const dynamic = 'force-dynamic';

// Disputes within scope (5.1): ?customerId=…&status=active|closed|all.
export const GET = withTenant(async (request: NextRequest, ctx) => {
  await ctx.requirePermission('dispute.read');
  const q = disputeListQuery.parse(Object.fromEntries(request.nextUrl.searchParams));
  return NextResponse.json(await listDisputes(ctx, q));
});

// Opens a dispute over one or more invoices of a customer (reason from code list dispute_reason).
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('dispute.create');
  const input = newDisputeSchema.parse(await request.json());
  return NextResponse.json(await openDispute(ctx, input), { status: 201 });
});
