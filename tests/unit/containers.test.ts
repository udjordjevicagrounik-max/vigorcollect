import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDbEnv } from '@/db/env';

// Which secret lives in which container (security review 2026-10-13, S-04 / S-10 / S-11).
// docker-compose.yml is the contract; a tiny indentation reader keeps this test dependency-free.

const COMPOSE = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');

type Service = { env: Record<string, string>; lines: string[] };

function services(yaml: string): Record<string, Service> {
  const out: Record<string, Service> = {};
  let inServices = false;
  let current: Service | null = null;
  let inEnv = false;
  for (const line of yaml.split('\n')) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith('services:');
      current = null;
      continue;
    }
    if (!inServices) continue;
    const name = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line)?.[1];
    if (name) {
      current = { env: {}, lines: [] };
      out[name] = current;
      inEnv = false;
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (/^ {4}\S/.test(line)) inEnv = false;
    const kv = inEnv ? /^ {6}([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line) : null;
    if (kv?.[1]) current.env[kv[1]] = kv[2] ?? '';
  }
  return out;
}

const S = services(COMPOSE);
const keys = (name: string) => Object.keys(S[name]?.env ?? {}).sort();
const has = (name: string, pattern: RegExp) => (S[name]?.lines ?? []).some((l) => pattern.test(l));

describe('S-04: the migration role is only in the one-shot migrate service', () => {
  it('no long-running service has MIGRATE_DATABASE_URL or vigor_migrate', () => {
    for (const name of ['app', 'worker', 'renderer']) {
      expect(keys(name)).not.toContain('MIGRATE_DATABASE_URL');
      expect(Object.values(S[name]?.env ?? {}).join(' ')).not.toContain('vigor_migrate');
    }
    expect(
      Object.entries(S)
        .filter(([, s]) => 'MIGRATE_DATABASE_URL' in s.env)
        .map(([n]) => n),
    ).toEqual(['migrate']);
    expect(has('migrate', /profiles:\s*\['ops'\]/)).toBe(true);
    expect(has('migrate', /restart:\s*'no'/)).toBe(true);
  });

  it('the app and the worker start without MIGRATE_DATABASE_URL', () => {
    expect(
      readDbEnv({
        DATABASE_URL: 'postgres://vigor_app:x@db:5432/collect',
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      DATABASE_URL: 'postgres://vigor_app:x@db:5432/collect',
    });
  });

  it('scripts/migrate.sh without the URL in its environment hands over to the migrate service', () => {
    // A COPY of the script in an empty tree: no .env, no migrations, no psql reachable — this
    // test can never touch a database, whatever version of the script it runs.
    const tree = mkdtempSync(join(tmpdir(), 'migrate-sh-'));
    mkdirSync(join(tree, 'scripts'));
    copyFileSync(join(process.cwd(), 'scripts/migrate.sh'), join(tree, 'scripts/migrate.sh'));
    const bin = join(tree, 'bin');
    mkdirSync(bin);
    const log = join(tree, 'calls');
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$@" >> "${log}"\n`);
    writeFileSync(join(bin, 'psql'), '#!/bin/sh\nexit 99\n');
    chmodSync(join(bin, 'docker'), 0o755);
    chmodSync(join(bin, 'psql'), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tree } as unknown as NodeJS.ProcessEnv;
    const script = join(tree, 'scripts/migrate.sh');
    execFileSync('bash', [script, 'status'], { env, cwd: tree });
    execFileSync('bash', [script], { env, cwd: tree });
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'compose --profile ops run --rm --build migrate status',
      'compose --profile ops run --rm --build migrate up',
    ]);
  });
});

describe('S-10: Chromium runs in the renderer, which holds no secret', () => {
  it('the renderer environment is exactly one credential plus plain settings', () => {
    expect(keys('renderer')).toEqual([
      'CHROMIUM_PATH',
      'HOME',
      'NODE_ENV',
      'RENDER_DATABASE_URL',
      'TZ',
    ]);
    expect(S.renderer?.env.RENDER_DATABASE_URL).toMatch(/^postgres:\/\/vigor_renderer:/);
    expect(has('renderer', /cap_drop:\s*\[ALL\]/)).toBe(true);
    expect(has('renderer', /no-new-privileges:true/)).toBe(true);
    expect(has('renderer', /read_only:\s*true/)).toBe(true);
    expect(has('renderer', /^\s*volumes:/)).toBe(false);
    expect(has('renderer', /^\s*ports:/)).toBe(false);
  });

  it('the worker no longer starts Chromium: no CHROMIUM_PATH, no renderPdf import in jobs', () => {
    expect(keys('worker')).not.toContain('CHROMIUM_PATH');
    const jobs = join(process.cwd(), 'src/server/jobs');
    for (const file of readdirSync(jobs)) {
      const source = readFileSync(join(jobs, file), 'utf8');
      expect(source, file).not.toMatch(/from '@\/server\/documents\/pdf'/);
    }
    const service = readFileSync(join(process.cwd(), 'src/server/documents/service.ts'), 'utf8');
    expect(service).not.toMatch(/=\s*renderPdf\b/); // no in-process default renderer
  });
});

describe('S-11: backups are encrypted; the key that decrypts never reaches the worker', () => {
  it('worker: public recipient only, no identity, no restore role', () => {
    expect(keys('worker')).toContain('BACKUP_AGE_RECIPIENT');
    expect(keys('worker')).not.toContain('BACKUP_AGE_IDENTITY');
    expect(keys('worker')).not.toContain('RESTORE_DATABASE_URL');
  });

  it('only the one-shot restore-test service holds the identity', () => {
    expect(
      Object.entries(S)
        .filter(([, s]) => 'BACKUP_AGE_IDENTITY' in s.env)
        .map(([n]) => n),
    ).toEqual(['restore-test']);
    expect(has('restore-test', /profiles:\s*\['ops'\]/)).toBe(true);
    expect(has('restore-test', /backups:\/srv\/backups:ro/)).toBe(true);
  });
});
