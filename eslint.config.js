// Lint includes patch sources; typecheck covers tooling. Prettier owns formatting.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier/flat'

export default tseslint.config(
   { ignores: ['node_modules/', 'dist-patched/'] },

   js.configs.recommended,
   tseslint.configs.recommendedTypeChecked,

   {
      languageOptions: {
         parserOptions: { project: ['./tsconfig.eslint.json'], tsconfigRootDir: import.meta.dirname },
      },
      rules: {
         // An underscore marks intentionally unused names.
         '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      },
   },

   // Patches declare only the bundle interfaces they use; query builders remain untyped.
   {
      files: ['fixes/**/*.ts', 'features/**/*.ts'],
      rules: {
         // Validation and error matching intentionally stringify unknown bundle values.
         '@typescript-eslint/no-base-to-string': 'off',
         '@typescript-eslint/no-explicit-any': 'off',
         '@typescript-eslint/no-unsafe-argument': 'off',
         '@typescript-eslint/no-unsafe-assignment': 'off',
         '@typescript-eslint/no-unsafe-call': 'off',
         '@typescript-eslint/no-unsafe-member-access': 'off',
         '@typescript-eslint/no-unsafe-return': 'off',
      },
   },

   // Tests load the bundle dynamically and assert on untyped responses.
   {
      files: ['pins/**/*.ts', 'test/**/*.ts', '**/test.ts'],
      rules: {
         // node:test tracks registered test promises.
         '@typescript-eslint/no-floating-promises': 'off',
         // In-memory adapters retain the driver's async interface.
         '@typescript-eslint/require-await': 'off',
         '@typescript-eslint/no-base-to-string': 'off',
         '@typescript-eslint/no-explicit-any': 'off',
         '@typescript-eslint/no-unsafe-argument': 'off',
         '@typescript-eslint/no-unsafe-assignment': 'off',
         '@typescript-eslint/no-unsafe-call': 'off',
         '@typescript-eslint/no-unsafe-member-access': 'off',
         '@typescript-eslint/no-unsafe-return': 'off',
      },
   },

   // JavaScript configuration files are outside the TypeScript project.
   { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },

   prettier,
)
