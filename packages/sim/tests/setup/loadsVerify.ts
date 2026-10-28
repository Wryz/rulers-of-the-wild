// P38 (perf proof): with ROTW_LOADS_VERIFY=1 every test runs the loads memos (world/loads.ts) in verify mode, which
// recomputes each memoised answer from Rapier and throws on any difference. Off by default (it costs the memos' gain).
import { Loads } from '../../src/world/loads';

if (process.env.ROTW_LOADS_VERIFY === '1') Loads.verify = true;
