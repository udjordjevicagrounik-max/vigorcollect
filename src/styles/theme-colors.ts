// The PWA manifest, <meta name="theme-color"> and the generated PWA icons cannot read CSS
// variables, so these values mirror src/styles/tokens.css. tests/unit/tokens.test.ts fails if they drift.
export const themeColors = {
  brandGreen: '#006633',
  background: '#f7f8f5',
  brandGold: '#c9a227',
} as const;
