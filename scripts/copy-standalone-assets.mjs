// `output: 'standalone'` does not copy static assets; the standalone server needs them locally.
import { cpSync, existsSync } from 'node:fs';

cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
if (existsSync('public')) cpSync('public', '.next/standalone/public', { recursive: true });
// Worker process entry (task 1.3): same image, `node worker.mjs`.
cpSync('scripts/worker-entry.mjs', '.next/standalone/worker.mjs');
// Renderer process entry (review S-10): same image, `node renderer.mjs`.
cpSync('scripts/renderer-entry.mjs', '.next/standalone/renderer.mjs');
// Ops scripts: the worker's nightly backup; the one-shot compose services restore-test and
// migrate (profile ops, review S-04 / S-11) run them from the same image.
for (const f of ['backup.sh', 'restore-test.sh', 'migrate.sh', 'lib/pg-admin.sh']) {
  cpSync(`scripts/${f}`, `.next/standalone/ops/${f}`);
}
// migrate.sh reads <its dir>/../db/migrations.
cpSync('db/migrations', '.next/standalone/db/migrations', { recursive: true });
