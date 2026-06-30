import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'node_modules/',
      // Standalone Expo app — not a workspace member; has its own lint/tsconfig.
      'apps/mobile/',
      'dist/',
      '**/dist/',
      'public/',
      '**/public/chunks/',
      '**/release/',
      'packages/skills/public/**/scripts/**/static/',
      'apps/cli/src/*.js',
      'drizzle/',
      'data/',
      '*.config.ts',
      '*.config.js',
      '**/*.mjs',
    ],
  },

  // Base JS recommended
  js.configs.recommended,

  // TypeScript recommended
  ...tseslint.configs.recommended,

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
