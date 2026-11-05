import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  { files: ['**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } } },
  // the page, and the functions the UI drive evaluates inside it
  { files: ['web/public/**/*.js', 'tests/ui.drive.js'], languageOptions: { globals: { ...globals.browser } } },
  { ignores: ['target/**', 'node_modules/**', 'web/.data/**'] },
];
