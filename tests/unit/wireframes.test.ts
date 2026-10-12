import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/wireframes: reference screens for Sprint 1/2 (task 0.3). Static, no framework, no build.

const DIR = join(process.cwd(), 'docs/wireframes');
const SCREENS = [
  'dashboard.html',
  'customer-360.html',
  'case.html',
  'import.html',
  'admin-users.html',
];
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8');

describe('wireframes', () => {
  it('has exactly the 5 screens', () => {
    expect(
      readdirSync(DIR)
        .filter((f) => f.endsWith('.html'))
        .sort(),
    ).toEqual([...SCREENS].sort());
  });

  it.each(SCREENS)('%s declares a mobile class, links tokens.css and has an empty state', (f) => {
    const html = read(f);
    expect(html).toMatch(
      /<meta name="mobile-class" content="(mobile-full|mobile-compact|desktop-only)">/,
    );
    expect(html).toContain('href="../../src/styles/tokens.css"');
    expect(html).toContain('class="when-empty');
    expect(html).toContain('lang="sr-Latn"');
  });

  it('no raw color values outside tokens.css (hex, rgb, hsl)', () => {
    const files = [...SCREENS, 'wireframe.css', 'wireframe.js'];
    const raw = files.filter((f) =>
      /#[0-9a-fA-F]{3,8}\b(?![-\w])|rgba?\(|hsla?\(/.test(read(f).replace(/href="#[^"]*"/g, '')),
    );
    expect(raw).toEqual([]);
  });

  it('no framework and no product name (rule 21)', () => {
    for (const f of SCREENS) {
      const html = read(f);
      expect(html, f).not.toMatch(/<script[^>]+src="https?:/);
      expect(html, f).not.toMatch(/vigor/i);
    }
  });

  it('every local link points to an existing screen or anchor', () => {
    for (const f of SCREENS) {
      const html = read(f);
      for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
        if (!href || href.startsWith('?') || href === '#') continue;
        const [file, anchor] = href.split('#');
        if (file) expect(existsSync(join(DIR, file)), `${f} → ${href}`).toBe(true);
        if (anchor) {
          const target = file ? read(file) : html;
          expect(target, `${f} → ${href}`).toContain(`id="${anchor}"`);
        }
      }
    }
  });
});
