import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'sim',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // One event-loop turn before every test (tests/setup/yieldBetweenTests.ts: Vitest's RPC between synchronous tests).
    setupFiles: ['./tests/setup/yieldBetweenTests.ts'],
    // Generous limits: the suite runs Rapier and long fights, and must not fail on a busy
    // machine. A timeout never changes what a test asserts.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
