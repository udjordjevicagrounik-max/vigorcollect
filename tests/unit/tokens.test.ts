import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { themeColors } from '@/styles/theme-colors';

const tokensCss = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8');

function token(name: string): string | undefined {
  return new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokensCss)?.[1]?.toLowerCase();
}

describe('design tokens', () => {
  it('theme-colors.ts mirrors tokens.css', () => {
    expect(themeColors.brandGreen).toBe(token('color-brand-green'));
    expect(themeColors.background).toBe(token('color-background'));
    expect(themeColors.brandGold).toBe(token('color-brand-gold'));
  });
});
