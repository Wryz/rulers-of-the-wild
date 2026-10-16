import { defineConfig } from 'vitest/config';

// One Vitest config at the root runs every workspace package's tests.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
