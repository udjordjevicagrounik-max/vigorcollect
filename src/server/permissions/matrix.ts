/**
 * Parser for the permission matrix in docs/permissions.md — the single source of truth for the
 * `permissions` catalog (migration 004) and for system-role grants (seed). Pure: callers read
 * the file. Fails loudly on anything it does not understand, so a malformed edit of the
 * document never silently drops a permission.
 */

export const RULE_11_APPROVALS = [
  'approval.write_off',
  'approval.credit_limit',
  'approval.block_customer',
  'approval.legal_handover',
  'approval.risk_override',
] as const;

export type PermissionRow = {
  key: string;
  description: string;
  /** Roles that hold the permission (✅ or 🅼). */
  roles: string[];
  /** Subset of `roles` that may use it only as checker in a maker-checker flow (🅼). */
  checkerOnly: string[];
};

export type PermissionMatrix = {
  roles: string[];
  permissions: PermissionRow[];
};

export class MatrixError extends Error {
  override name = 'MatrixError';
}

const KEY = /^`([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`$/;
const ROLE = /^`([a-z][a-z0-9_]{1,62})`$/;
const CELL = { allowed: '✅', denied: '➖', checker: '🅼' } as const;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function parsePermissionMatrix(markdown: string): PermissionMatrix {
  const lines = markdown.split('\n');
  const headerAt = lines.findIndex((l) => cells(l)[0] === 'objekat.akcija');
  if (headerAt < 0) throw new MatrixError('Matrix header "objekat.akcija" not found.');

  const header = cells(lines[headerAt] ?? '');
  const roles = header.slice(2).map((h) => {
    const m = ROLE.exec(h);
    if (!m?.[1]) throw new MatrixError(`Invalid role column: ${h}`);
    return m[1];
  });
  if (roles.length === 0) throw new MatrixError('Matrix has no role columns.');

  const permissions: PermissionRow[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(headerAt + 2)) {
    if (!line.trim().startsWith('|')) break;
    const row = cells(line);
    const key = KEY.exec(row[0] ?? '')?.[1];
    if (!key) throw new MatrixError(`Invalid permission key cell: ${row[0] ?? ''}`);
    if (seen.has(key)) throw new MatrixError(`Duplicate permission key: ${key}`);
    seen.add(key);
    if (row.length !== roles.length + 2) {
      throw new MatrixError(`Row ${key} has ${row.length} cells, expected ${roles.length + 2}.`);
    }
    const granted: string[] = [];
    const checkerOnly: string[] = [];
    roles.forEach((role, i) => {
      const cell = row[i + 2];
      if (cell === CELL.allowed) granted.push(role);
      else if (cell === CELL.checker) {
        granted.push(role);
        checkerOnly.push(role);
      } else if (cell !== CELL.denied) {
        throw new MatrixError(`Row ${key}, role ${role}: unknown cell "${cell ?? ''}".`);
      }
    });
    permissions.push({ key, description: row[1] ?? '', roles: granted, checkerOnly });
  }
  if (permissions.length === 0) throw new MatrixError('Matrix has no permission rows.');
  return { roles, permissions };
}

/** Permission keys per role, in matrix order. */
export function grantsByRole(matrix: PermissionMatrix): Map<string, string[]> {
  const out = new Map<string, string[]>(matrix.roles.map((r) => [r, []]));
  for (const p of matrix.permissions) for (const r of p.roles) out.get(r)?.push(p.key);
  return out;
}
