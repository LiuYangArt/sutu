module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaFeatures: {
      jsx: true,
    },
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  settings: {
    react: {
      version: 'detect',
    },
  },
  rules: {
    // React 17+ 不需要显式导入 React
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',

    // TypeScript 相关
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',

    // React Hooks
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',

    // 代码风格
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'prefer-const': 'error',
    'no-var': 'error',
  },
  overrides: [
    {
      files: ['src/components/Canvas/**/*.{ts,tsx}'],
      excludedFiles: [
        'src/components/Canvas/index.tsx',
        'src/components/Canvas/usePointerHandlers.ts',
        'src/components/Canvas/useRawPointerInput.ts',
        'src/components/Canvas/useStrokeProcessor.ts',
        'src/components/Canvas/useUnifiedInputIngress.ts',
        'src/components/Canvas/__tests__/**/*.{ts,tsx}',
      ],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: "MemberExpression[object.name='pendingPointsRef']",
            message:
              'Do not write drawing queue refs outside ingress whitelist modules. Route input via UnifiedSessionRouterV3 + Gate.',
          },
          {
            selector: "MemberExpression[object.name='inputQueueRef']",
            message:
              'Do not write drawing queue refs outside ingress whitelist modules. Route input via UnifiedSessionRouterV3 + Gate.',
          },
        ],
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules', 'src-tauri/target'],
};
