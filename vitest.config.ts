import { configDefaults, defineConfig } from 'vitest/config';

// One Vitest config at the root runs every workspace package's tests.
//
// The sim project extends its own packages/sim/vitest.config.ts with two entries the test harness owns (P23,
// docs/M1-DESIGN.md §11.0, §11.9):
// - globalSetup: tests/support/globalSetup.ts builds the cached scenes (the AC-2(b)/AC-3 pit) once per source hash, in
//   the main process, before any worker starts; the AC files read them with cachedScene().
// - the AC-9 rehearsal (`*.rehearsal.test.ts`) is not part of `npm test`: it runs only with ROTW_REHEARSAL=1, which
//   `npm run test:rehearsal` sets.
const rehearsal = process.env.ROTW_REHEARSAL === '1';

export default defineConfig({
  test: {
    projects: [
      {
        extends: './packages/sim/vitest.config.ts',
        root: './packages/sim',
        test: {
          globalSetup: ['./tests/support/globalSetup.ts'],
          exclude: rehearsal ? [...configDefaults.exclude] : [...configDefaults.exclude, '**/*.rehearsal.test.ts'],
        },
      },
      'apps/*',
    ],
  },
});
