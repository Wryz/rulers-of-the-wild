// P38 (perf proof): with ROTW_LOADS_VERIFY=1 every test runs the loads memos (world/loads.ts) in verify mode, which
// recomputes each memoised answer from Rapier and throws on any difference. Off by default (it costs the memos' gain).
//
// Imported only when asked: a setup file that imported the sim would load its modules before a test file's vi.mock
// (worldImpactCalls.test.ts, contacts.test.ts mock sim/impact.ts), and the sim would keep the real ones. With the flag
// on, those few mock-based tests can't see their mocks; the verify run is for the memos, not for them.
if (process.env.ROTW_LOADS_VERIFY === '1') {
  const { Loads } = await import('../../src/world/loads');
  Loads.verify = true;
}

export {};
