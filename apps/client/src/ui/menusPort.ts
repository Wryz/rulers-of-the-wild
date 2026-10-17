// The menus behind MenusPort: the settings overlay (ui/settings.ts, changed by P35), the battle log (ui/battleLog.ts) and
// the session recording it shows (game/recorder.ts). An open menu pauses the game loop (rule 8); the recording is
// started once per session (docs/M1-DESIGN.md §10.11; the clip button is M5). The adapter file P35 changes, so game.ts
// never has to (RF-9).
//
// DungeonStyle's settings, battle log and marks (game.ts logHit). A recording is filed when the player dies and the next
// starts at the respawn, so a session isn't one ever-growing video. A menu opening lets go of the pointer (the mouse
// looks around under pointer lock, §5.14), so its buttons can be clicked.
// P35: Settings lists M1's controls (§5.14) and the pad's; "Blood effects" sets prefs.gore ('full' / 'off'), the one
// value game.ts goreOf reads (rule 12; the three-level setting is M5's); a "Crouch key" row picks toggle or hold.
// C-fix: the "Fight tips" row went with DS's tips HUD (§10.8's minimal HUD has none), and "Combat cues" names only what it
// still does (hit flashes, the cues callouts, longer hit-pauses: DS's telegraph rings went with the training ring).
// TODO(M5): the rolling 30 s buffer and the clip button replace this.
import type { Fighter, World } from '@wild/sim';
import type { MenusPort, SimEvent } from '../game/ports';
import type { Prefs } from '../game/prefs';
import type { BattleRecorder } from '../game/recorder';
import type { BattleLog } from './battleLog';
import type { SettingsMenu } from './settings';

export class Menus implements MenusPort {
  private take = 0;

  constructor(
    readonly settings: SettingsMenu,
    readonly log: BattleLog,
    readonly recorder: BattleRecorder,
    private readonly player: () => Fighter | null,
    /** The HUD's battle-log button: it shows REC while a take is filming (DS). */
    private readonly recButton: HTMLElement | null = null,
  ) {
    recorder.enabled = settings.prefs.record;
    this.startRecording();
  }

  get open(): boolean {
    return this.settings.isOpen || this.log.isOpen;
  }

  get prefs(): Readonly<Prefs> {
    return this.settings.prefs;
  }

  toggleSettings(): void {
    this.settings.toggle();
  }

  openLog(): void {
    if (this.open) return;
    if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock?.();
    this.log.open();
  }

  /** The battle log's marks (DS game.ts logHit, block and dodge marks), and a take filed at each of your deaths. */
  handle(e: SimEvent, _world: World): void {
    const me = this.player();
    const r = this.recorder;
    const who = (f: Fighter) => (f === me ? 'You' : f.name);
    switch (e.type) {
      case 'hit': {
        const dmg = Math.max(1, Math.round(e.damage));
        const what = e.weapon ? `${e.weapon.name} ${e.move.name.toLowerCase()}` : e.move.name;
        if (e.fatal) r.mark('gore', `${who(e.attacker)}: ${e.fatal === 'split' ? 'skull split' : e.fatal === 'cleft' ? 'skull cleft' : 'skull crushed'}`);
        else if (e.sever) r.mark('gore', `${who(e.attacker)}: ${e.sever === 'head' ? 'decapitation' : 'limb off'}`);
        if (e.knockdown && !e.ko) r.mark('down', `${who(e.defender)} knocked down (${what.toLowerCase()})`);
        else if (e.attacker === me && (dmg >= 12 || e.counter)) r.mark('hit', `${e.counter ? 'Counter ' : ''}${what} · ${dmg}`);
        else if (e.defender === me && dmg >= 12) r.mark('hurt', `Hit by ${what.toLowerCase()} · -${dmg}`);
        return;
      }
      case 'block':
        if (e.guardBreak) r.mark('down', e.defender === me ? 'Your guard broken' : 'Guard broken');
        else if (e.parry && e.perfect) r.mark('parry', 'Perfect parry');
        return;
      case 'dodge':
        if (e.defender === me && e.perfect) r.mark('parry', 'Perfect dodge');
        return;
      case 'ko':
        if (e.victim === me) r.mark('death', e.environmental ? 'Killed by the Wild' : e.killer ? `Knocked out by ${who(e.killer)}` : 'Knocked out');
        else r.mark('ko', `KO — ${e.victim.name}${e.environmental ? ' (the Wild)' : ''}`);
        return;
      case 'death':
        if (e.f === me) r.stop('lost');
        return;
      case 'respawn':
        if (e.f === me) this.startRecording();
        return;
      default:
        return;
    }
  }

  frame(paused: boolean): void {
    this.recorder.tick(paused);
  }

  afterRender(): void {
    const r = this.recorder;
    r.afterRender();
    this.recButton?.classList.toggle('rec', r.recording && r.enabled && r.canRecord);
  }

  private startRecording(): void {
    this.take++;
    this.recorder.start({ round: this.take, arena: 'The Clearing', opponent: 'The Wild', boss: false });
  }
}
