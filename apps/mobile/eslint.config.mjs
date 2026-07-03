// Standalone ESLint config — the root config ignores apps/mobile (workspace
// isolation), so the mobile app lints itself with its own dependency-free setup.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['node_modules/', '.expo/', 'dist/', 'android/', 'ios/', '*.config.js', 'targets/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Just the two classic hook rules — the v7 "recommended" extras flag
      // standard RN idioms (useRef(new Animated.Value()).current etc.).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      // Markdown/i18n strings legitimately contain full-width punctuation/spaces.
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipRegExps: true }],
    },
  },
);
