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
    // Generous limits: the suite runs Rapier and long fights, and must not fail on a busy
    // machine. A timeout never changes what a test asserts.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
