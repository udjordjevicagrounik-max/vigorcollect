import { z } from 'zod';

const dbEnvSchema = z.object({
  // Application role: vigor_app (no BYPASSRLS, no SUPERUSER) — rule 3.
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // Migration role: vigor_migrate. Used by scripts/migrate.sh, never by request handlers.
  MIGRATE_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type DbEnv = z.infer<typeof dbEnvSchema>;

export function readDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  return dbEnvSchema.parse(source);
}
