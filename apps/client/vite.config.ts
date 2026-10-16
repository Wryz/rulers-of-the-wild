import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  test: {
    name: 'client',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
