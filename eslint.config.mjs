import js from '@eslint/js';
import i18next from 'eslint-plugin-i18next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// eslint-config-next is intentionally not used: its fast-glob → micromatch → braces chain has an
// unfixed high-severity advisory and would fail `npm audit --audit-level=high` (see ADR 0001).

const HEX_COLOR = '/#[0-9a-fA-F]{3}([0-9a-fA-F]{3}([0-9a-fA-F]{2})?)?\\b/';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': [
        'error',
        {
          // Rule 5: sql.raw() only with explicit approval in the task.
          selector: "CallExpression[callee.object.name='sql'][callee.property.name='raw']",
          message: 'sql.raw() requires explicit approval (CLAUDE.md rule 5).',
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Rule 16: session (or anything) never in Web Storage.
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'Web Storage is forbidden (CLAUDE.md rule 16).' },
        { name: 'sessionStorage', message: 'Web Storage is forbidden (CLAUDE.md rule 16).' },
      ],
    },
  },
  {
    // Rule 17: no hardcoded UI strings — JSX text and user-visible attributes go through t().
    files: ['src/app/**/*.tsx', 'src/components/**/*.tsx'],
    ...i18next.configs['flat/recommended'],
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          'jsx-attributes': {
            exclude: [
              'className',
              'style',
              'type',
              'key',
              'id',
              'href',
              'actionHref',
              'mobileClass',
              'role',
              'rel',
              'target',
              'lang',
              'htmlFor',
              'name',
              'method',
              'autoComplete',
              'inputMode',
              'aria-hidden',
              'aria-labelledby',
              'aria-describedby',
              'aria-controls',
              'data-.*',
            ],
          },
        },
      ],
    },
  },
  {
    // Design tokens: no hex colors in components (CLAUDE.md "Design tokeni").
    files: ['src/app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=${HEX_COLOR}]`,
          message: 'Use a semantic token (tailwind.config.ts), never a hex color.',
        },
        {
          selector: `TemplateElement[value.raw=${HEX_COLOR}]`,
          message: 'Use a semantic token (tailwind.config.ts), never a hex color.',
        },
        {
          selector: "CallExpression[callee.object.name='sql'][callee.property.name='raw']",
          message: 'sql.raw() requires explicit approval (CLAUDE.md rule 5).',
        },
      ],
    },
  },
);
