// Error codes of our API (no imports: shared by server and browser code). Every code has a
// message under `errors.*` in messages/*.json (tests/unit/api-error.test.ts).
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
  'self_action',
  'last_owner',
  'unsupported',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export function isApiErrorCode(value: string): value is ApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(value);
}
