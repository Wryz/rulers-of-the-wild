// The sim project's setup file (packages/sim/vitest.config.ts setupFiles): before every test, one turn of the worker's
// event loop (a macrotask), so Vitest's RPC is answered between tests.
//
// Why: the runner goes from one test to the next on promises (microtasks) only, so the worker's event loop never turns
// between tests that run synchronously. A file of such tests chains them into one block: AC-2(b)'s nine pit runs
// (≈ 15-20 s each) blocked the loop for 168 s, past birpc's 60 s timeout, and the run failed with the unhandled error
// "[vitest-worker]: Timeout calling onTaskUpdate" with every test passed. A single test longer than that still needs
// its own yields (tests/support/yieldToVitest.ts). Never changes what a test sends the sim.
import { beforeEach } from 'vitest';
import { yieldToVitest } from '../support/yieldToVitest';

beforeEach(yieldToVitest);
