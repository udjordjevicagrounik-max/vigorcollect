import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Golden (never delete or skip) — review S-01: application code reads canonical legal entities
// ONLY through legal_entities_public (public register columns). A direct FROM/JOIN on
// legal_entities in src/ fails here; the database refuses the bookkeeping columns anyway.

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('golden: no direct reads of legal_entities in application code', () => {
  it('every FROM / JOIN goes through legal_entities_public', () => {
    const offenders = files(join(process.cwd(), 'src')).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /\b(FROM|JOIN)\s+(public\.)?legal_entities\b(?!_public)/i.test(line))
        .map(({ i }) => `${file.replace(process.cwd() + '/', '')}:${i + 1}`),
    );
    expect(offenders).toEqual([]);
  });
});
