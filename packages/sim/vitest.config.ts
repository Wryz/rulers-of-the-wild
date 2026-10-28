import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'sim',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // One event-loop turn before every test (tests/setup/yieldBetweenTests.ts: Vitest's RPC between synchronous tests);
    // ROTW_LOADS_VERIFY=1 checks the loads memos against Rapier in every test (tests/setup/loadsVerify.ts, P38).
    setupFiles: ['./tests/setup/yieldBetweenTests.ts', './tests/setup/loadsVerify.ts'],
    // Generous limits: the suite runs Rapier and long fights, and must not fail on a busy
    // machine. A timeout never changes what a test asserts.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
