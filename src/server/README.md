# src/server

API routes and domain services. Every route: `withTenant()` → `requirePermission('object.action')`
→ Zod validation → service → `audit()` (+ `domain_events` when something is triggered).
See CLAUDE.md, NON-NEGOTIABLE rules 1–12.
