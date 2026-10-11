import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json' with { type: 'json' };
import sr from '../../messages/sr-Latn.json' with { type: 'json' };

function keys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe('messages', () => {
  // Rule 17: sr-Latn is the source; en is added in the same task.
  it('en has exactly the same keys as sr-Latn', () => {
    expect(keys(en).sort()).toEqual(keys(sr).sort());
  });

  it('no message is empty', () => {
    for (const messages of [en, sr]) {
      const empty = keys(messages).filter((k) => {
        const value = k
          .split('.')
          .reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], messages);
        return typeof value !== 'string' || value.trim() === '';
      });
      expect(empty).toEqual([]);
    }
  });
});
