import type { Config } from 'tailwindcss';

// Semantic color tokens. Values come from src/styles/tokens.css (CSS variables);
// components use these names only — never hex (CLAUDE.md, "Design tokeni").
// Loaded through `@config` in globals.css — see docs/adr/0001-stack.md.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'brand-green': 'var(--color-brand-green)',
        'brand-green-deep': 'var(--color-brand-green-deep)',
        'brand-purple': 'var(--color-brand-purple)',
        'brand-purple-soft': 'var(--color-brand-purple-soft)',
        'brand-gold': 'var(--color-brand-gold)',
        surface: 'var(--color-surface)',
        background: 'var(--color-background)',
        text: 'var(--color-text)',
        'text-muted': 'var(--color-text-muted)',
        border: 'var(--color-border)',
        'status-success': {
          fg: 'var(--color-status-success-fg)',
          bg: 'var(--color-status-success-bg)',
        },
        'status-warning': {
          fg: 'var(--color-status-warning-fg)',
          bg: 'var(--color-status-warning-bg)',
        },
        'status-danger': {
          fg: 'var(--color-status-danger-fg)',
          bg: 'var(--color-status-danger-bg)',
        },
        'status-info': {
          fg: 'var(--color-status-info-fg)',
          bg: 'var(--color-status-info-bg)',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      fontWeight: {
        normal: '400',
        medium: '500',
        semibold: '600',
      },
    },
  },
};

export default config;
