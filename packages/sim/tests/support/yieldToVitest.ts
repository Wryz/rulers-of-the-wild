/** Let the worker service Vitest RPC between batches of synchronous simulation work. */
export const yieldToVitest = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Test-only scheduling interval; never changes the ticks or commands the simulation receives. */
export const YIELD_TICKS = 200;
