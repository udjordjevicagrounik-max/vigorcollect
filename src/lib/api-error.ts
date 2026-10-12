import { NextResponse } from 'next/server';

/**
 * The ONE error shape of our API (task 1.4): {code, message_key, request_id}. Never a stack, a
 * SQL message or a value. The UI shows t(message_key) + the request id for support (rule 29).
 * Every code has a message under `errors.*` in messages/*.json (unit test).
 */
export const API_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'forbidden_origin',
  'not_found',
  'invalid_request',
  'conflict',
  'not_pending',
  'already_member',
  'user_disabled',
  'unknown_role',
  'invalid',
  'expired',
  'sign_in_required',
  'wrong_account',
  'weak_password',
  'captcha_failed',
  'rate_limited',
  'approval_required',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

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

export function isApiErrorCode(value: string): value is ApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(value);
}
