// The PWA manifest and <meta name="theme-color"> cannot read CSS variables, so these two
// values mirror src/styles/tokens.css. tests/unit/tokens.test.ts fails if they drift.
export const themeColors = {
  brandGreen: '#006633',
  background: '#f7f8f5',
} as const;
