// Structured log line (stdout, JSON). Fields are P0 only — ids, kinds, counts, codes; never an
// e-mail address, name, token, link or password (rules 9, 20). Callers pass values, not objects
// they did not build, so nothing personal can slip in by accident.
export type LogValue = string | number | boolean | null;

export function logEvent(event: string, fields: Record<string, LogValue> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}
