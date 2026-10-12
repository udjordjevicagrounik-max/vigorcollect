import { NextResponse } from 'next/server';
import type { ApiErrorCode } from './api-error-codes';

/**
 * The ONE error shape of our API (task 1.4): {code, message_key, request_id}. Never a stack, a
 * SQL message or a value. The UI shows t(message_key) + the request id for support (rule 29).
 * Every code has a message under `errors.*` in messages/*.json (unit test).
 */
export { API_ERROR_CODES, isApiErrorCode, type ApiErrorCode } from './api-error-codes';

export type ApiErrorBody = { code: ApiErrorCode; message_key: string; request_id: string | null };

export function apiErrorBody(code: ApiErrorCode, requestId: string | null): ApiErrorBody {
  return { code, message_key: `errors.${code}`, request_id: requestId };
}

export function apiError(
  status: number,
  code: ApiErrorCode,
  requestId: string | null,
): NextResponse {
  return NextResponse.json(apiErrorBody(code, requestId), {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}
