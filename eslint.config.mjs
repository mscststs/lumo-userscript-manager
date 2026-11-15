import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'public/user-scripts/**',
      'i18n/locales/*.json',
      'docs/**',
      '.agents/**',
      '.claude/**',
      'agent/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // The project intentionally types values crossing Chrome/IDB boundaries
      // as `any` in a few adapters; the public surfaces are typed.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // A few controls use custom ARIA patterns with full keyboard handling.
      'jsx-a11y/no-noninteractive-element-interactions': 'warn',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      // Native <dialog> intentionally autofocuses the safe action / first field,
      // and the interactive guards are already reviewed by the a11y tests.
      'jsx-a11y/no-autofocus': 'off',
      // Scrollable code regions are intentionally in the tab order.
      'jsx-a11y/no-noninteractive-tabindex': 'off',
      'jsx-a11y/media-has-caption': 'off',
      // React Compiler-era lint rules flag several established external-system
      // effects and ref-mirroring patterns used in this project.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
    },
  },
);
