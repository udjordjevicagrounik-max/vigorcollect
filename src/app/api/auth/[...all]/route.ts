import { getAuth } from '@/server/auth/better-auth';

// Better Auth endpoints (/api/auth/*). Public by nature — listed in docs/permissions.md
// "Javne rute"; protection: rate limit, lockout, identical answers (rule 27).
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export function POST(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
