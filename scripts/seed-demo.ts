/**
 * Deterministic demo seed (rule 24). Generated data only — never real data.
 * Dates are relative to "today" (UTC) so demo aging stays realistic.
 *
 * Empty frame for 0.1. TODO(1.6): insert demo tenant, legal entities, invoices through the same
 * services as manual actions (audit + domain_events), using `rng` for every random value.
 */

const SEED = 20260101;

/** Mulberry32 — tiny deterministic PRNG; the same SEED always yields the same data. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Calendar date (YYYY-MM-DD) offset from today in UTC — `date` semantics, not a timestamp. */
export function daysFromToday(offset: number, today: Date = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const rng = createRng(SEED);
  void rng;
  console.warn('seed-demo: no tables yet (Schema v1 arrives in 0.2) — nothing seeded.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
