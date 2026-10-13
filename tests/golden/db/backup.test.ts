import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { alertsCheck } from '@/server/jobs/ops';
import { Pool } from 'pg';
import { appPool, closePools, migratePool, sqlState, workerPool } from './helpers';

// Golden (never delete or skip) — rule 28, task 1.7: the nightly backup dumps every database,
// keeps 30 daily copies, never contains .env or role passwords, records the run; the restore
// test restores the latest dump and finds every row; a fresh backup silences the backup alarm.
// Review S-11: every file is age-encrypted to a public recipient, live tokens (auth.session,
// auth.verification) are never in the dump, and only the restore context with the identity can
// read it — never the worker.

const DIR = mkdtempSync(join(tmpdir(), 'golden-backup-'));
const TEST_DB = new URL(process.env.TEST_MIGRATE_DATABASE_URL ?? '').pathname.slice(1);
/** A service-role URL from .env, pointed at the test database. */
function onTestDb(name: 'BACKUP_DATABASE_URL' | 'RESTORE_DATABASE_URL'): string {
  const url = new URL(process.env[name] ?? '');
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}
const BACKUP_URL = onTestDb('BACKUP_DATABASE_URL');
// A throwaway age key pair for this run (generated here, never stored).
const AGE_IDENTITY_FILE = join(DIR, '.identity');
execFileSync('age-keygen', ['-o', AGE_IDENTITY_FILE], { stdio: 'ignore' });
const AGE_IDENTITY = (readFileSync(AGE_IDENTITY_FILE, 'utf8').match(/^AGE-SECRET-KEY-1\S+$/m) ?? [
  '',
])[0];
const AGE_RECIPIENT = execFileSync('age-keygen', ['-y', AGE_IDENTITY_FILE], {
  encoding: 'utf8',
}).trim();
rmSync(AGE_IDENTITY_FILE);
const SESSION_TOKEN = `golden-live-session-${Date.now()}`;
const RESTORE_URL = onTestDb('RESTORE_DATABASE_URL');
// Never the superuser: the scripts get only the service-role URLs.
const withoutSuperuser = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== 'POSTGRES_USER' && k !== 'POSTGRES_PASSWORD'),
);
const env: NodeJS.ProcessEnv = {
  ...withoutSuperuser,
  NODE_ENV: 'test',
  BACKUP_DIR: DIR,
  POSTGRES_DB: TEST_DB,
  BACKUP_DATABASE_URL: BACKUP_URL,
  RESTORE_DATABASE_URL: RESTORE_URL,
  BACKUP_S3_BUCKET: '',
  BACKUP_AGE_RECIPIENT: AGE_RECIPIENT,
  BACKUP_AGE_IDENTITY: AGE_IDENTITY,
};
const run = (script: string, extra: Record<string, string> = {}) =>
  execFileSync('bash', [join(process.cwd(), 'scripts', script)], {
    env: { ...env, ...extra },
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
/** Exit status of a script run that is expected to fail. */
const status = (script: string, extra: Record<string, string>) => {
  try {
    run(script, extra);
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
};
/** Decrypts a backup file with this run's identity (the restore context). */
const decrypt = (file: string): Buffer =>
  execFileSync('bash', ['-c', 'age -d -i <(printf "%s\\n" "$ID") "$F"'], {
    env: { ...process.env, ID: AGE_IDENTITY, F: file },
    maxBuffer: 256 * 1024 * 1024,
  });

afterAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  await closePools();
});

describe('golden/db: service roles for backup and restore (never the superuser)', () => {
  it('vigor_backup reads everything through RLS but writes nothing (except its own ops_runs row — trigger, since BYPASSRLS skips policies)', async () => {
    const backup = new Pool({ connectionString: BACKUP_URL, max: 1 });
    try {
      const role = await backup.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: true }]);
      const users = await backup.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
      expect(users.rows[0]?.n).toBeGreaterThan(0); // no tenant context needed: BYPASSRLS
      const writes = {
        insertUser: await sqlState(
          backup.query(
            `INSERT INTO users (tenant_id, email, display_name, timezone) SELECT tenant_id, 'x@y.test', 'x', 'UTC' FROM users LIMIT 1`,
          ),
        ),
        updateCustomer: await sqlState(backup.query(`UPDATE customers SET status = 'blocked'`)),
        deleteAudit: await sqlState(backup.query('DELETE FROM audit_log')),
        updateRun: await sqlState(backup.query(`UPDATE ops_runs SET status = 'failed'`)),
        foreignKind: await sqlState(
          backup.query(
            `INSERT INTO ops_runs (kind, status, started_at, finished_at) VALUES ('restore_test', 'ok', now(), now())`,
          ),
        ),
      };
      expect(writes).toEqual({
        insertUser: '42501',
        updateCustomer: '42501',
        deleteAudit: '42501',
        updateRun: '42501',
        foreignKind: '42501',
      });
    } finally {
      await backup.end();
    }
  });

  it('vigor_restore cannot read the main database', async () => {
    const restore = new Pool({ connectionString: RESTORE_URL, max: 1 });
    try {
      expect(await sqlState(restore.query('SELECT 1 FROM users LIMIT 1'))).toBe('42501');
      expect(await sqlState(restore.query('SELECT 1 FROM customers LIMIT 1'))).toBe('42501');
    } finally {
      await restore.end();
    }
  });
});

describe('golden/db: backup and restore test', () => {
  it('no recipient (or no age) → no backup at all', () => {
    expect(status('backup.sh', { BACKUP_AGE_RECIPIENT: '' })).not.toBe(0);
    expect(status('backup.sh', { BACKUP_AGE_RECIPIENT: 'not-a-key' })).not.toBe(0);
  }, 120_000);

  it('dumps every database, keeps 30 days, no .env and no role passwords, records ok', async () => {
    // A live session token in the database (rule 28 / review S-11: it must not reach the dump).
    const inserted = await migratePool.query(
      `INSERT INTO auth."session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       SELECT gen_random_uuid(), now() + interval '1 hour', $1, now(), now(), id FROM auth."user" LIMIT 1`,
      [SESSION_TOKEN],
    );
    expect(inserted.rowCount).toBe(1);
    for (let d = 1; d <= 35; d += 1)
      mkdirSync(join(DIR, 'daily', `2020-01-${String(d).padStart(2, '0')}`), { recursive: true });
    expect(run('backup.sh')).toMatch(/^backup: ok/m);

    const days = readdirSync(join(DIR, 'daily')).sort();
    expect(days).toHaveLength(30);
    const today = join(DIR, 'daily', days[days.length - 1] ?? '');
    const files = readdirSync(today);
    const dump = `db-${env.POSTGRES_DB}.dump.age`;
    expect(files).toEqual(expect.arrayContaining(['globals.sql.age', 'manifest.json', dump]));
    expect(files.some((f) => f.startsWith('.env'))).toBe(false);
    // Encrypted at rest: no plain dump, no plain SQL — only age files next to the manifest.
    expect(files.filter((f) => f !== 'manifest.json').every((f) => f.endsWith('.age'))).toBe(true);
    for (const f of files.filter((name) => name.endsWith('.age'))) {
      const head = readFileSync(join(today, f)).subarray(0, 21).toString('latin1');
      expect(head).toBe('age-encryption.org/v1');
    }
    expect(readFileSync(join(today, dump)).includes(SESSION_TOKEN)).toBe(false);
    // Decrypted (restore context only): no live session token, no role passwords.
    const plain = decrypt(join(today, dump));
    expect(plain.subarray(0, 5).toString('latin1')).toBe('PGDMP');
    const data = execFileSync('pg_restore', ['--data-only', '-f', '-'], {
      input: plain,
      maxBuffer: 256 * 1024 * 1024,
    }).toString('utf8');
    expect(data).not.toContain(SESSION_TOKEN);
    expect(data).not.toMatch(/^COPY auth\."?(session|verification)"? /m);
    expect(data).toMatch(/^COPY auth\.account /m); // the rest of auth is still there
    expect(decrypt(join(today, 'globals.sql.age')).toString('utf8')).not.toMatch(
      /PASSWORD|SCRAM-SHA|md5[0-9a-f]{32}/,
    );
    const manifest = JSON.parse(readFileSync(join(today, 'manifest.json'), 'utf8')) as {
      files: { sha256: string }[];
    };
    expect(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(existsSync(join(DIR, 'monthly'))).toBe(true);
  }, 120_000);

  it('the restore test never runs without the identity, nor in the worker', () => {
    expect(status('restore-test.sh', { BACKUP_AGE_IDENTITY: '' })).not.toBe(0);
    expect(status('restore-test.sh', { PROCESS_ROLE: 'worker' })).toBe(2);
  }, 120_000);

  it('the restore test restores the latest dump and every table count matches', async () => {
    await migratePool.query(`DELETE FROM auth."session" WHERE token = $1`, [SESSION_TOKEN]);
    expect(run('restore-test.sh')).toMatch(
      /^restore-test: ok — backup \S+, \d+ tables, \d+ rows match/m,
    );
    const { rows } = await migratePool.query<{ kind: string; status: string }>(
      `(SELECT kind, status FROM ops_runs WHERE kind = 'restore_test' ORDER BY finished_at DESC LIMIT 1)
       UNION ALL
       (SELECT kind, status FROM ops_runs WHERE kind = 'backup' ORDER BY finished_at DESC LIMIT 1)`,
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
