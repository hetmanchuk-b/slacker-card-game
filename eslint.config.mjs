import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', '*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    ignores: ['src/client/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                '**/server/**',
                '**/runtime/**',
                '**/persistence/**',
                '**/projections/**',
                '**/game/**',
                '**/protocol/messages*',
              ],
              allowTypeImports: true,
              message:
                'Browser code consumes wire DTO types, not authoritative server/engine implementations.',
            },
          ],
        },
      ],
    },
  },
);
