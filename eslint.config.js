import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      // The mappers/handlers deliberately take `any` at trust boundaries (remote JSON, MCP args).
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Structural enforcement of the local↔hub boundary (review #9): the feed must
    // consume only public metadata + core TYPES — never the write path or adapters.
    files: ['src/feed/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/core/writer',
                '**/core/writer.js',
                '**/core/orchestrator',
                '**/core/orchestrator.js',
                '**/core/inventory',
                '**/core/inventory.js',
                '**/adapters/*',
              ],
              message:
                'feed/ must stay decoupled from the write path — it consumes only public metadata + core types (inventory is passed in, never fetched).',
            },
          ],
        },
      ],
    },
  },
);
