module.exports = {
  root: true,
  extends: '@react-native',
  ignorePatterns: [
    'node_modules/',
    'android/',
    'ios/',
    'coverage/',
    'model-release/',
    'tools/',
    'infra/',
    'src/infrastructure/inference/runtimeFixture.ts',
    'src/features/about/notices/*.ts',
  ],
  rules: {
    // `void promise` marks a deliberate fire-and-forget call.
    'no-void': 'off',
    // forwardRef(function Name() {}) intentionally repeats the export name.
    '@typescript-eslint/no-shadow': 'off',
    'react/no-unstable-nested-components': ['warn', {allowAsProps: true}],
    // Styles are computed from theme tokens at render time.
    'react-native/no-inline-styles': 'off',
    'no-bitwise': 'off',
  },
};
