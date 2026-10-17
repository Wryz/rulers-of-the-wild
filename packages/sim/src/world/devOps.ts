// Developer operations (docs/M1-DESIGN.md §1.3, §3 phase 1c; RF-19): every `meta 'dev'` command is applied here in
// phase 1c of its tick, so the command log replays dev actions exactly (rule 7, RR-17).
//
// STUB (P05; P22 fills it): the final exported signature. `setTuning` already works (registry.setTuningValue), so the
// dev panel's live edits are commands from the start; every other op throws until P22.
import type { MetaCommand } from '../sim/commands';
import { setTuningValue } from '../tuning/registry';
import type { World } from './world';

/** Applies one `meta 'dev'` command now (phase 1c). Throws on a command without a dev payload. */
export function applyDevOp(w: World, cmd: MetaCommand): void {
  const dev = cmd.dev;
  if (cmd.meta !== 'dev' || !dev) throw new Error(`applyDevOp: tick ${cmd.tick}: not a dev command`);
  switch (dev.op) {
    case 'setTuning': {
      const t = dev.tuning;
      if (!t) throw new Error(`applyDevOp: tick ${cmd.tick}: setTuning without a tuning edit`);
      setTuningValue(t.table, t.key, t.value);
      return;
    }
    default:
      throw new Error(`world/devOps.ts: dev op ${dev.op} is not implemented yet (P22; world tick ${w.tick})`);
  }
}
