# src/db/schema

Drizzle table definitions used **only** as a typed query builder.

- Source of truth is SQL in `db/migrations/NNN_*_up.sql` (CLAUDE.md rule 4).
- These files mirror the migrations; they never generate them. `drizzle-kit push` is forbidden.
- Empty until 0.2 (Schema v1).
