import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'node_modules/',
      'dist/',
      '**/dist/',
      '**/target/',
      '.cargo-home/',
      'public/',
      'packages/db/migrations/',
      'data/',
      // The Expo app is not a workspace member: it installs its own node_modules
      // and lints itself (`cd apps/client && pnpm lint`, apps/client/eslint.config.mjs).
      // Linting it from here resolves a second TypeScript project root and fails
      // or passes depending on whether the mobile app happens to be installed —
      // the same reason .prettierignore and tsconfig exclude it.
      'apps/client/',
      '*.config.ts',
      '*.config.js',
      '**/*.mjs',
    ],
  },

  // Base JS recommended
  js.configs.recommended,

  // TypeScript recommended
  ...tseslint.configs.recommended,

  // Pin the project root: a nested app with its own tsconfig (apps/client) would
  // otherwise leave typescript-eslint with two candidate roots, and which one it
  // picks depends on what is installed locally.
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },

  // React Hooks
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Project-specific rules
  {
    rules: {
      // Relax rules for practical development
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-constant-condition': 'off',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      'no-unused-private-class-members': 'off',
      'no-new-native-nonconstructor': 'off',
      'preserve-caught-error': 'off',
    },
  },

  // Prettier (must be last — disables conflicting formatting rules)
  prettier,
);
