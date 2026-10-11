import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Public liveness probe (see docs/permissions.md, "Public routes").
// Correlation and version headers are added by src/proxy.ts.
// TODO(1.6): add DB readiness check (SELECT 1 as vigor_app) without leaking details.
export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
