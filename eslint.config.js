// Lint rules for this repository.
//
// Type-aware, through tsconfig.eslint.json rather than tsconfig.json: `npm run typecheck` covers the
// tooling, while the patch sources under fixes/ and features/ are deliberately outside it — they are
// written against `declare`d bindings the bundle supplies. The linter still reads their types.
//
// Formatting is Prettier's alone; eslint-config-prettier goes last and turns off anything that would
// argue with it.
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
         // An unused name is a mistake worth hearing about, but a deliberately ignored one is not:
         // `_` prefixes it, which is the convention the codebase already uses for discarded captures.
         '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      },
   },

   // A patch speaks to the bundle through an interface that stops at what it touches, so kysely's
   // query builders are `any` there: typing them would mean copying a schema this repository does
   // not own.
   {
      files: ['fixes/**/*.ts', 'features/**/*.ts'],
      rules: {
         // A patch reads values whose type the bundle does not declare — a body field, a database
         // cell, a link in an error's cause chain — and turns them into text for a message or a
         // pattern match. `[object Object]` is the intended answer for a shape that should not be
         // there: it fails the regex and becomes a 400.
         '@typescript-eslint/no-base-to-string': 'off',
         '@typescript-eslint/no-explicit-any': 'off',
         '@typescript-eslint/no-unsafe-argument': 'off',
         '@typescript-eslint/no-unsafe-assignment': 'off',
         '@typescript-eslint/no-unsafe-call': 'off',
         '@typescript-eslint/no-unsafe-member-access': 'off',
         '@typescript-eslint/no-unsafe-return': 'off',
      },
   },

   // The suites drive a bundle loaded by path at runtime, so nothing about it is typed. Asserting on
   // a parsed JSON body is unavoidably an operation on `any`.
   {
      files: ['pins/**/*.ts', 'test/**/*.ts', '**/test.ts'],
      rules: {
         // `test()` from node:test returns a promise the runner itself tracks, and calling it without
         // `await` is how the runner is meant to be used. The rule still applies everywhere else,
         // which is where an unawaited promise is a bug rather than the documented spelling.
         '@typescript-eslint/no-floating-promises': 'off',
         // The suites stand in for adapters the library calls with `await`, so a stub that answers
         // from a Map still has to be `async`. Having nothing to await is the point of a stub.
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

   // This config file itself. It is JavaScript and outside the TypeScript project, so the type-aware
   // rules have nothing to read.
   { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },

   prettier,
)
