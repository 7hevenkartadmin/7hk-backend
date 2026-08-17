export default [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-constant-condition': 'error',
    },
  },
];
