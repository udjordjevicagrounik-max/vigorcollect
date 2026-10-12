import { NextResponse } from 'next/server';
import { healthReport, liveHealthDeps } from '@/server/health';

export const dynamic = 'force-dynamic';

// Public liveness/readiness probe (docs/permissions.md, "Javne rute"): database reachability and
// job aggregates (pending, failed, oldest pending age, last retention run) — never data.
// Correlation and version headers are added by src/proxy.ts.
export async function GET(): Promise<NextResponse> {
  const report = await healthReport(liveHealthDeps);
  return NextResponse.json(report, {
    status: report.db === 'ok' ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
