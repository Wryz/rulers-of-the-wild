// Moments from a tick's events (docs/M1-DESIGN.md §10.3, SPEC:583-588): what deserves a kill cam, read off the sim's
// events after each stepped tick, in event order (CombatSim's events first, then the world's, §3). KillCam.onMoment
// receives each one; nothing here changes the sim (rule 6) or time (rule 8).
//
//   envKill        CombatEvent `ko`, environmental, of a creature that is neither a ruler nor a player (SPEC:415, 869)
//   worldWound     WorldEvent `wound` with byWorld: an entity nobody holds, or the terrain a world trip threw it onto
//   rulerDeath     CombatEvent `ko` of a ruler
//   playerByRuler  a ruler flings the player (WorldEvent `impact` on the player, launched, caused by a ruler's body; or
//                  the player's `launch` right after a ruler's knock, a swat), or kills the player (the `ko`'s killer
//                  is a ruler, or the player's last knock was a ruler's within IMPACT_TUNING.envKillWindowS)
//   playerDeath    the player's other deaths (CombatEvent `ko`; the `death` event when no `ko` came with it)
//   skullSplit     CombatEvent `hit` with a fatal head blow (split, cleft or crushed) and no severed limb (DS skullBlow)
//
// One death or fling makes one moment: the player's `ko` and `death` of a tick are one death, and an impact's launch
// (phase 9) with the `launch` event that follows it (next tick's phase 4a) is one fling.
import { Vector3 } from 'three';
import { type BoneName, type CombatEvent, DT, type Fighter, IMPACT_TUNING, type StepResult, type V3, type WorldEvent } from '@wild/sim';
import type { Moment, MomentKind } from './killcam';
import type { MomentsPort } from './ports';

/** What the builder reads of the world: the tick it presents and the fighters (whom a cause's fighter id names). */
export interface MomentWorld {
  readonly tick: number;
  readonly combat: { readonly fighters: readonly Fighter[] };
}

type Impact = Extract<WorldEvent, { type: 'impact' }>;
type Hit = Extract<CombatEvent, { type: 'hit' }>;
type Ko = Extract<CombatEvent, { type: 'ko' }>;

/** The way a moment points when nothing in the events says (any horizontal direction gives a shot a side). */
const NO_DIR = Object.freeze({ x: 0, y: 0, z: 1 });

export class MomentBuilder implements MomentsPort {
  private readonly world: MomentWorld | null;
  private readonly tickOf: () => number;
  /** Per player, the tick of the last ruler knock reported as a fling (an impact and its launch are one fling). */
  private readonly flung = new WeakMap<Fighter, number>();

  /**
   * `source`: the world (preferred), or only its tick. DEVIATION (P36): P31's main.ts passes `() => world.tick`; without
   * the world's fighters a cause's fighter id names nobody, so a ruler's body impact on the player and a death after a
   * ruler's knock are not recognised as playerByRuler (a ruler's own blow or kill still is, through the event's
   * Fighter). TODO(C-fix): main.ts passes `new MomentBuilder(world)`.
   */
  constructor(source: MomentWorld | (() => number)) {
    if (typeof source === 'function') {
      this.world = null;
      this.tickOf = source;
    } else {
      const w = source;
      this.world = w;
      this.tickOf = () => w.tick;
    }
  }

  fromStep(r: StepResult): Moment[] {
    const tick = this.tickOf();
    const out: Moment[] = [];
    /** Players whose death or fling this tick already made a moment. */
    const players = new Set<Fighter>();
    const add = (m: Moment | null) => {
      if (!m) return;
      if (m.kind === 'playerDeath' || m.kind === 'playerByRuler') {
        if (players.has(m.subject)) return;
        players.add(m.subject);
      }
      out.push(m);
    };
    for (const e of r.combat) add(this.fromCombat(e, r, tick));
    for (const e of r.world) add(this.fromWorld(e, r, tick, players));
    return out;
  }

  // ---------------------------------------------------------------------------

  private fromCombat(e: CombatEvent, r: StepResult, tick: number): Moment | null {
    if (e.type === 'hit') return skull(e, tick);
    if (e.type !== 'ko') return null;
    const v = e.victim;
    const { point, dir } = this.koPoint(e, r);
    const causeEntity = e.cause?.entityId ?? null;
    if (v.ruler) return moment('rulerDeath', tick, v, point, dir, causeEntity, 1);
    if (v.playerId !== null) {
      const byRuler = !!e.killer?.ruler || this.knockedByRuler(v, tick);
      return moment(byRuler ? 'playerByRuler' : 'playerDeath', tick, v, point, dir, causeEntity, 1);
    }
    // A player's environmental death is the player's death above (the death cam), never an envKill.
    if (e.environmental) return moment('envKill', tick, v, point, dir, causeEntity, 1);
    return null;
  }

  private fromWorld(e: WorldEvent, r: StepResult, tick: number, players: ReadonlySet<Fighter>): Moment | null {
    switch (e.type) {
      case 'wound': {
        if (!e.byWorld) return null;
        const f = e.ruler;
        // The impact that opened it carries the exact point and the way it went; else the wound's place on the bone.
        const hit = r.world.find((x): x is Impact => x.type === 'impact' && x.wound !== null && (x.wound === e.wound || x.wound.id === e.wound.id));
        const point = hit ? vec(hit.point) : woundPoint(f, e.wound.bone, e.wound.local);
        const dir = hit ? unit(hit.dir) : inward(f, point);
        const maxHp = f.ruler?.maxHp ?? f.stats.maxHp;
        return moment('worldWound', tick, f, point, dir, e.wound.cause.entityId, frac(e.wound.hp, maxHp));
      }
      case 'impact': {
        const f = e.defender;
        if (f.playerId === null || !e.launched || players.has(f)) return null;
        if (!this.isRuler(e.cause.fighterId)) return null;
        this.flung.set(f, e.tick);
        const dv = unit(e.dv);
        return moment('playerByRuler', tick, f, vec(e.point), dv.lengthSq() > 0 ? dv : unit(e.dir), e.cause.entityId, frac(e.damage, f.stats.maxHp));
      }
      case 'launch': {
        // A ruler's swat (its blow knocked the player down this tick), or the launch of an impact fling already reported.
        const f = e.f;
        const k = f.lastKnock;
        if (f.playerId === null || players.has(f) || !k || k.by === null) return null;
        if (k.tick > tick || tick - k.tick > 1 || this.flung.get(f) === k.tick) return null;
        const blow = r.combat.find((x): x is Hit => x.type === 'hit' && x.defender === f && !!x.attacker.ruler);
        if (!blow && !this.isRuler(k.by)) return null;
        this.flung.set(f, k.tick);
        const vel = unit(e.vel);
        return moment('playerByRuler', tick, f, f.rig.pelvis.pos.clone(), vel.lengthSq() > 0 ? vel : unit(NO_DIR), k.cause.entityId, blow ? frac(blow.damage, f.stats.maxHp) : 1);
      }
      case 'death': {
        // The player's `ko` of this tick made the death's moment; a death without one is still a death.
        const f = e.f;
        if (f.playerId === null || players.has(f)) return null;
        const kind: MomentKind = this.knockedByRuler(f, tick) ? 'playerByRuler' : 'playerDeath';
        return moment(kind, tick, f, f.rig.pelvis.pos.clone(), unit(NO_DIR), f.lastKnock?.cause.entityId ?? null, 1);
      }
      default:
        return null;
    }
  }

  /** The KO's point, and the way the finishing blow went: the impact that did it, else from the killer, else NO_DIR. */
  private koPoint(e: Ko, r: StepResult): { point: Vector3; dir: Vector3 } {
    const v = e.victim;
    const point = vec(e.point);
    let hit: Impact | null = null;
    for (const x of r.world) if (x.type === 'impact' && x.defender === v && x.ko) hit = x;
    const along = hit ? unit(hit.dir) : null;
    if (along && along.x * along.x + along.z * along.z > 1e-6) return { point, dir: along };
    if (e.killer && e.killer !== v) {
      const d = new Vector3(v.pos.x - e.killer.pos.x, 0, v.pos.z - e.killer.pos.z);
      if (d.lengthSq() > 1e-9) return { point, dir: d.normalize() };
    }
    return { point, dir: along ?? unit(NO_DIR) };
  }

  /** The player's last knock was a ruler's, within IMPACT_TUNING.envKillWindowS (the sim's "knocked into it" window). */
  private knockedByRuler(f: Fighter, tick: number): boolean {
    const k = f.lastKnock;
    if (!k || k.by === null || k.tick > tick) return false;
    if (tick - k.tick > Math.round(IMPACT_TUNING.envKillWindowS / DT)) return false;
    return this.isRuler(k.by);
  }

  /** Whether the fighter with this id is a ruler (false when nobody, or without the world's fighters). */
  private isRuler(id: number | null): boolean {
    if (id === null || !this.world) return false;
    return !!this.world.combat.fighters.find((f) => f.id === id)?.ruler;
  }
}

/** A crown split, cleft or crushed (DS skullBlow; a severed limb or head has its own story and no kill cam in M1). */
function skull(e: Hit, tick: number): Moment | null {
  if (!e.fatal || e.sever) return null;
  const tool = e.attacker.inventory?.hands;
  const causeEntity = tool && tool.mode === 'wield' ? tool.entity : null;
  return moment('skullSplit', tick, e.defender, e.point.clone(), e.dir.clone(), causeEntity, 1);
}

function moment(kind: MomentKind, tick: number, subject: Fighter, point: Vector3, dir: Vector3, causeEntity: number | null, severity: number): Moment {
  return { kind, tick, subject, point, dir, causeEntity, severity };
}

function vec(v: V3): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

/** `v` as a unit vector (zero stays zero). */
function unit(v: V3): Vector3 {
  const u = vec(v);
  return u.lengthSq() > 0 ? u.normalize() : u;
}

/** a / b clamped to 0..1 (0 when b isn't positive). */
function frac(a: number, b: number): number {
  return b > 0 ? Math.min(1, Math.max(0, a / b)) : 0;
}

/** A point on a bone given in its frame at authored scale (DS Wound.local, WoundRecord.local), in the world now. */
export function woundPoint(f: Fighter, bone: BoneName, local: V3): Vector3 {
  const x = f.rig[bone];
  return new Vector3(local.x, local.y, local.z).multiplyScalar(f.scale).applyQuaternion(x.rot).add(x.pos);
}

/** Into the body from `point` (toward the pelvis), the way a wound's blow went when nothing else says. */
function inward(f: Fighter, point: Vector3): Vector3 {
  const d = f.rig.pelvis.pos.clone().sub(point);
  return d.lengthSq() > 0 ? d.normalize() : unit(NO_DIR);
}
