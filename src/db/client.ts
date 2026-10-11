// Server-side module: never import from a 'use client' file.
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { readDbEnv } from './env';

// Drizzle is used as a query builder only. Schema truth lives in db/migrations/*.sql (rule 4).
// TODO(0.2/1.x): request code reaches the DB only through withTenant() (rule 2), which wraps
// each transaction in SET LOCAL app.tenant_id. Do not export `appDb` to route handlers directly.

let appPool: Pool | undefined;
let migratePool: Pool | undefined;

/** Application pool — connects as vigor_app; RLS applies. */
export function getAppPool(): Pool {
  appPool ??= new Pool({ connectionString: readDbEnv().DATABASE_URL, max: 10 });
  return appPool;
}

/** Migration/maintenance pool — connects as vigor_migrate. Scripts and jobs only. */
export function getMigratePool(): Pool {
  migratePool ??= new Pool({ connectionString: readDbEnv().MIGRATE_DATABASE_URL, max: 2 });
  return migratePool;
}

export function getAppDb(): NodePgDatabase {
  return drizzle(getAppPool());
}
