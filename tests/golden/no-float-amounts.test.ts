import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Golden (never delete or skip) — rule 18: an amount never passes through a float. The semgrep
// rule no-float-amounts (lefthook) is the gate; this test keeps the rule itself and the numeric
// type parser from silently disappearing. Column types are checked in golden/db/receivables.

const ROOT = process.cwd();

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|mjs)$/.test(name) ? [path] : [];
  });
}

function floatRule(): RegExp {
  const yml = readFileSync(join(ROOT, '.semgrep.yml'), 'utf8');
  const block = yml.split('- id: no-float-amounts')[1];
  const raw = /pattern-regex: '(.*)'\s*$/m.exec(block ?? '')?.[1];
  if (!raw) throw new Error('semgrep rule no-float-amounts is missing');
  return new RegExp(raw.replace(/^\(\?i\)/, '').replaceAll("''", "'"), 'i');
}

describe('golden: no float over amounts (rule 18)', () => {
  it('the semgrep rule exists and catches the float paths', () => {
    const rule = floatRule();
    for (const bad of [
      'Number(row.amount_open)',
      'parseFloat(inv.amountTotal)',
      'Math.round(paidAmount * 100)',
      'totalOpen.toFixed(2)',
      'Number(r.fx_rate)',
    ]) {
      expect(rule.test(bad), bad).toBe(true);
    }
    expect(rule.test('Number(rows[0].n)')).toBe(false);
    expect(rule.test('toMinor(row.amount_open)')).toBe(false);
  });

  it('no source file matches the rule', () => {
    const rule = floatRule();
    const hits = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'scripts'))]
      .filter((f) => rule.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  it('node-postgres keeps numeric as a string (no setTypeParser for numeric)', () => {
    const hits = files(join(ROOT, 'src')).filter((f) =>
      /setTypeParser\s*\(\s*(?:1700|types\.builtins\.NUMERIC)/.test(readFileSync(f, 'utf8')),
    );
    expect(hits).toEqual([]);
  });
});
