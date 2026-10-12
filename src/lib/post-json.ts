import { REQUEST_ID_HEADER } from './request-id';

// Browser-side JSON POST to our own origin (session cookie included). Returns the status, the
// parsed body and the X-Request-Id, so an error message can show the id for support (rule 29).
export type PostResult = { status: number; json: unknown; requestId: string | null };

export async function postJSON(path: string, body: unknown): Promise<PostResult> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, requestId: res.headers.get(REQUEST_ID_HEADER) };
  } catch {
    return { status: 0, json: null, requestId: null };
  }
}

/** Better Auth / our routes put a machine-readable code in `code` or `error`. */
export function errorCode(json: unknown): string {
  const body = json as { code?: unknown; error?: unknown } | null;
  if (typeof body?.code === 'string') return body.code;
  if (typeof body?.error === 'string') return body.error;
  return '';
}
