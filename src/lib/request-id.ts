export const REQUEST_ID_HEADER = 'x-request-id';
export const APP_VERSION_HEADER = 'x-app-version';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Reuse an upstream correlation id only if it is a well-formed UUID; never trust arbitrary input.
export function resolveRequestId(incoming: string | null): string {
  return incoming && UUID_RE.test(incoming) ? incoming.toLowerCase() : crypto.randomUUID();
}
