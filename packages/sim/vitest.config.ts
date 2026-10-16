import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'sim',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
