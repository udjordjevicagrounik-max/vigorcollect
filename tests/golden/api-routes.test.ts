import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Golden (never delete or skip): a route without requirePermission does not exist (rule 7).
// Every src/app/api/**/route.ts is either listed in docs/permissions.md "Javne rute" or wraps
// EVERY exported HTTP handler in withTenant() and calls requirePermission(). At runtime
// withTenant() additionally fails closed (500) when a handler skips requirePermission().

const API_DIR = join(process.cwd(), 'src', 'app', 'api');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}

/** src/app/api/invitations/[id]/revoke/route.ts → /api/invitations/[id]/revoke */
function routePath(file: string): string {
  const parts = relative(API_DIR, file).split(sep).slice(0, -1);
  return `/api/${parts.join('/')}`.replace(/\/$/, '');
}

/** Public API routes from the "Javne rute" table; `*` / `[...x]` = any suffix. */
export function publicApiRoutes(markdown: string): string[] {
  const section = markdown.split('## Javne rute')[1] ?? '';
  return [...section.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
    .flatMap((m) => [...(m[1] ?? '').matchAll(/`([^`]+)`/g)].map((c) => c[1] ?? ''))
    .filter((r) => r.startsWith('/api/'));
}

function isPublic(path: string, publicRoutes: string[]): boolean {
  return publicRoutes.some((r) => {
    if (r.endsWith('/*')) return path.startsWith(r.slice(0, -1)) || path === r.slice(0, -2);
    return r === path;
  });
}

/** Problems of one non-public route source; empty = compliant. */
export function routeViolations(source: string): string[] {
  const problems: string[] = [];
  const exported = METHODS.filter((m) =>
    new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${m}\\b`).test(source),
  );
  if (exported.length === 0) problems.push('no HTTP handler exported');
  for (const m of exported) {
    if (!new RegExp(`export\\s+const\\s+${m}\\s*=\\s*withTenant\\s*[<(]`).test(source)) {
      problems.push(`${m} is not wrapped in withTenant()`);
    }
  }
  const checks = (
    source.match(/requirePermission\(\s*'[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*'\s*\)/g) ?? []
  ).length;
  if (checks < exported.length) problems.push('requirePermission() missing for a handler');
  return problems;
}

/**
 * Zod at the edge (task 1.4): request input reaches code only through a schema. Body:
 * `Schema.parse(await request.json())` (or safeParse); route params: `schema.safeParse(params)`;
 * query: `schema.parse(Object.fromEntries(request.nextUrl.searchParams))`. Better Auth's own
 * catch-all route validates with its own schemas.
 */
export function zodViolations(source: string): string[] {
  const problems: string[] = [];
  const bodies = (source.match(/request\.json\(\)/g) ?? []).length;
  const parsedBodies = (source.match(/[pP]arse\(\s*await\s+request\.json\(\)/g) ?? []).length;
  if (bodies > parsedBodies) problems.push('request body not parsed by a Zod schema');
  if (/\bparams\b/.test(source.replace(/searchParams/g, '')) && /withTenant<\{/.test(source)) {
    if (!/[pP]arse\(\s*params\s*\)/.test(source))
      problems.push('route params not parsed by a Zod schema');
  }
  if (
    /searchParams/.test(source) &&
    !/[pP]arse\(\s*Object\.fromEntries\([^)]*searchParams/.test(source)
  ) {
    problems.push('query not parsed by a Zod schema');
  }
  if (/request\.(formData|text)\(\)/.test(source)) problems.push('non-JSON body is not allowed');
  return problems;
}

describe('golden: every API route parses its input with Zod (1.4)', () => {
  const files = routeFiles(API_DIR).filter((f) => !routePath(f).startsWith('/api/auth'));

  it('body, params and query of every route go through a schema', () => {
    const violations = files
      .map((f) => ({ route: routePath(f), problems: zodViolations(readFileSync(f, 'utf8')) }))
      .filter((v) => v.problems.length > 0);
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(violations).toEqual([]);
  });

  it('the checker catches raw input', () => {
    expect(zodViolations('const b = await request.json(); use(b.email);')).toContain(
      'request body not parsed by a Zod schema',
    );
    expect(
      zodViolations(
        'export const GET = withTenant<{ id: string }>(async (r, ctx, params) => db(params.id));',
      ),
    ).toContain('route params not parsed by a Zod schema');
    expect(zodViolations("const q = request.nextUrl.searchParams.get('x');")).toContain(
      'query not parsed by a Zod schema',
    );
    expect(zodViolations('const input = schema.parse(await request.json());')).toEqual([]);
  });
});

describe('golden: every API route is public-by-document or permission-checked', () => {
  const publicRoutes = publicApiRoutes(
    readFileSync(join(process.cwd(), 'docs', 'permissions.md'), 'utf8'),
  );
  const files = routeFiles(API_DIR);

  it('finds the routes and the public list (the scan is not vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(publicRoutes).toEqual(
      expect.arrayContaining(['/api/auth/*', '/api/invitations/accept']),
    );
  });

  it('no non-public route without withTenant + requirePermission', () => {
    const violations = files
      .filter((f) => !isPublic(routePath(f.replace(/\[\.\.\.[^\]]+\]/g, '*')), publicRoutes))
      .map((f) => ({ route: routePath(f), problems: routeViolations(readFileSync(f, 'utf8')) }))
      .filter((v) => v.problems.length > 0);
    expect(violations).toEqual([]);
  });

  it('every public API route in the document exists (no stale exceptions)', () => {
    const paths = files.map((f) => routePath(f).replace(/\/\[\.\.\.[^\]]+\]$/, '/*'));
    expect(publicRoutes.filter((r) => !paths.includes(r))).toEqual([]);
  });

  it('the checker itself catches the bad patterns', () => {
    expect(routeViolations(`export async function GET() { return new Response(); }`)).toContain(
      'GET is not wrapped in withTenant()',
    );
    expect(
      routeViolations(`export const POST = withTenant(async (req, ctx) => { return x; });`),
    ).toContain('requirePermission() missing for a handler');
    expect(
      routeViolations(
        `export const GET = withTenant(async (r, ctx) => { await ctx.requirePermission('user.read'); });`,
      ),
    ).toEqual([]);
  });
});
