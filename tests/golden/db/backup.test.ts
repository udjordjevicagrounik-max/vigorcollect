import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { alertsCheck } from '@/server/jobs/ops';
import { appPool, closePools, migratePool, workerPool } from './helpers';

// Golden (never delete or skip) — rule 28, task 1.7: the nightly backup dumps every database,
// keeps 30 daily copies, never contains .env or role passwords, records the run; the restore
// test restores the latest dump and finds every row; a fresh backup silences the backup alarm.

const DIR = mkdtempSync(join(tmpdir(), 'golden-backup-'));
const env = {
  ...process.env,
  BACKUP_DIR: DIR,
  POSTGRES_DB: new URL(process.env.TEST_MIGRATE_DATABASE_URL ?? '').pathname.slice(1),
  BACKUP_S3_BUCKET: '',
};
const run = (script: string) =>
  execFileSync('bash', [join(process.cwd(), 'scripts', script)], {
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });

afterAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  await closePools();
});

describe('golden/db: backup and restore test', () => {
  it('dumps every database, keeps 30 days, no .env and no role passwords, records ok', () => {
    for (let d = 1; d <= 35; d += 1)
      mkdirSync(join(DIR, 'daily', `2020-01-${String(d).padStart(2, '0')}`), { recursive: true });
    expect(run('backup.sh')).toMatch(/^backup: ok/m);

    const days = readdirSync(join(DIR, 'daily')).sort();
    expect(days).toHaveLength(30);
    const today = join(DIR, 'daily', days[days.length - 1] ?? '');
    const files = readdirSync(today);
    expect(files).toEqual(
      expect.arrayContaining(['globals.sql', 'manifest.json', `db-${env.POSTGRES_DB}.dump`]),
    );
    expect(files.some((f) => f.startsWith('.env'))).toBe(false);
    expect(readFileSync(join(today, 'globals.sql'), 'utf8')).not.toMatch(
      /PASSWORD|SCRAM-SHA|md5[0-9a-f]{32}/,
    );
    const manifest = JSON.parse(readFileSync(join(today, 'manifest.json'), 'utf8')) as {
      files: { sha256: string }[];
    };
    expect(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(existsSync(join(DIR, 'monthly'))).toBe(true);
  }, 120_000);

  it('the restore test restores the latest dump and every table count matches', async () => {
    expect(run('restore-test.sh')).toMatch(
      /^restore-test: ok — backup \S+, \d+ tables, \d+ rows match/m,
    );
    const { rows } = await migratePool.query<{ kind: string; status: string }>(
      `SELECT kind, status FROM ops_runs ORDER BY finished_at DESC LIMIT 2`,
    );
    expect(rows).toEqual([
      { kind: 'restore_test', status: 'ok' },
      { kind: 'backup', status: 'ok' },
    ]);
    const restoreCopies = await migratePool.query(
      `SELECT 1 FROM pg_database WHERE datname LIKE '%\\_restore\\_test'`,
    );
    expect(restoreCopies.rowCount).toBe(0);
  }, 120_000);

  it('after a fresh backup the backup alarm stays silent', async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const fired = await alertsCheck({ workerPool: workerPool(), appPool });
    expect(fired).not.toContain('backup_missing');
    expect(fired).not.toContain('restore_test_failed');
  });
});
