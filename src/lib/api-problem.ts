import { isApiErrorCode, type ApiErrorCode } from './api-error-codes';
import type { PostResult } from './post-json';

/**
 * Turns an API error answer {code, message_key, request_id} (src/lib/api-error.ts) into what a
 * form shows: t(message_key) and the request id for support (rule 29). Unknown shapes fall back
 * to errors.internal — a stack or a server message is never shown.
 */
export function apiProblem(
  res: PostResult,
  tErrors: (key: ApiErrorCode) => string,
): { message: string; requestId: string | null } {
  const body = res.json as { message_key?: unknown; request_id?: unknown } | null;
  const raw =
    typeof body?.message_key === 'string' && body.message_key.startsWith('errors.')
      ? body.message_key.slice('errors.'.length)
      : '';
  const key: ApiErrorCode = isApiErrorCode(raw) ? raw : 'internal';
  const requestId = typeof body?.request_id === 'string' ? body.request_id : res.requestId;
  return { message: tErrors(key), requestId };
}
