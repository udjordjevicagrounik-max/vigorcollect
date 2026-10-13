// Display of UNTRUSTED text (received e-mail, rule 22) — no imports: shared by server and browser
// code. The text is never HTML: it is split into plain segments and URLs; the UI renders both as
// text and a URL becomes a real link only after the reader explicitly asks for it ("open").
// Only http(s) URLs are ever offered; javascript:, data:, file: and friends stay inert text.

export type Segment = { kind: 'text'; value: string } | { kind: 'url'; value: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"'()]{1,2000}/gi;
const MAX = 100_000;

export function segments(text: string): Segment[] {
  const input = text.slice(0, MAX);
  const out: Segment[] = [];
  let last = 0;
  for (const m of input.matchAll(URL_RE)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ kind: 'text', value: input.slice(last, index) });
    const url = m[0].replace(/[.,;:!?]+$/, '');
    out.push({ kind: 'url', value: url });
    last = index + url.length;
  }
  if (last < input.length) out.push({ kind: 'text', value: input.slice(last) });
  return out;
}

/** A URL the reader chose to open: http(s) only, credentials stripped; anything else → null. */
export function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}
