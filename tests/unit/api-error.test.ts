import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json' with { type: 'json' };
import sr from '../../messages/sr-Latn.json' with { type: 'json' };
import { API_ERROR_CODES, apiErrorBody } from '@/lib/api-error';

describe('API error shape (1.4)', () => {
  it('is exactly {code, message_key, request_id}', () => {
    expect(apiErrorBody('forbidden', 'r-1')).toEqual({
      code: 'forbidden',
      message_key: 'errors.forbidden',
      request_id: 'r-1',
    });
  });

  it('every code has a message in sr-Latn and en', () => {
    for (const messages of [sr, en]) {
      const errors = messages.errors as Record<string, string>;
      expect(API_ERROR_CODES.filter((c) => !errors[c])).toEqual([]);
    }
  });
});
