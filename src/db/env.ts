import { z } from 'zod';

// Review S-04: the web app and the worker know ONLY their own role. The migration role
// (vigor_migrate, owner of every table) lives in the one-shot compose service `migrate`
// (profile ops) and in scripts/migrate.sh — never in a long-running process.
const dbEnvSchema = z.object({
  // Application role: vigor_app (no BYPASSRLS, no SUPERUSER) — rule 3.
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type DbEnv = z.infer<typeof dbEnvSchema>;

export function readDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  return dbEnvSchema.parse(source);
}
