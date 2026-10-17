import type { Rng } from '../sim/math';
import { numFromRecord } from './animator';
import type { LimbTarget, PoseSpec } from './skeleton';

export type FeintKind = 'jab' | 'shoulder' | 'level' | 'step';

export interface IdleStyle {
  /** Rhythm bounce frequency (Hz) and height (m). */
  bounceHz: number;
  bounceAmp: number;
  /** Weight-shift sway amplitude (m). */
  swayAmp: number;
  /** Seconds between feints [min, max]. */
  feintEvery: [number, number];
  feintWeights: Record<FeintKind, number>;
  /** Seconds between small re-stancing steps [min, max]. */
  shuffleEvery: [number, number];
  /** Seconds between lead-hand paws [min, max]. */
  pawEvery: [number, number];
  /** Rolling shoulders (heavy brawler swagger). */
  shoulderRoll: number;
}

interface Burst {
  t: number;
  dur: number;
}

const FEINT_FRAMES: Record<FeintKind, number> = { jab: 16, shoulder: 15, level: 20, step: 24 };

type V3 = [number, number, number];
const add = (a: V3 | undefined, b: V3): V3 => {
  const base = a ?? [0, 0, 0];
  return [base[0] + b[0], base[1] + b[1], base[2] + b[2]];
};
const addHand = (h: LimbTarget | undefined, d: V3): LimbTarget | undefined =>
  h ? { at: add(h.at, d), hint: h.hint } : h;

/** Envelope that snaps out and eases back (0 → 1 → 0). */
const snapEnv = (u: number) => (u <= 0 || u >= 1 ? 0 : u < 0.35 ? Math.sin((u / 0.35) * Math.PI * 0.5) : 0.5 + 0.5 * Math.cos(((u - 0.35) / 0.65) * Math.PI));

/**
 * Keeps an idle fighter alive between exchanges: bouncing in rhythm, shifting weight,
 * scanning with the head and shoulders, pawing with the lead hand, feinting, and taking
 * small repositioning steps. Purely visual — feints never trigger defenses.
 */
export class IdleBehavior {
  feint: (Burst & { kind: FeintKind }) | null = null;
  private paw: Burst | null = null;
  private t = 0;
  private bouncePhase = 0;
  private engagedBlend = 0;
  private feintTimer = 90;
  private shuffleTimer = 60;
  private pawTimer = 50;
  /** Current / target stance offset (fighter-local x, z). */
  private off = [0, 0];
  private offTarget = [0, 0];
  feints = 0;
  shuffles = 0;
  /** Live multipliers from the contextual motion profile. */
  readonly mods = { bounce: 1, bounceHz: 1, sway: 1, head: 1, feints: 1, paws: 1 };
  /**
   * Paused (the fighter's `idlePaused`, docs/M1-DESIGN.md §12.2 I16): idle life holds still where it is — no weight
   * shift, look-around, bounce, feint, paw or re-stancing — so a paused body moves only when something moves it.
   */
  paused = false;

  constructor(
    public style: IdleStyle,
    private readonly rng: Rng,
  ) {
    this.t = rng.range(0, 10);
    this.bouncePhase = rng.range(0, Math.PI);
  }

  /** Cancel any feint / paw in progress (an attack or defense is starting). */
  interrupt() {
    this.feint = null;
    this.paw = null;
  }

  /**
   * @param engaged an opponent is within fighting range
   * @param still the fighter is idle and not walking
   */
  tick(engaged: boolean, still: boolean) {
    // Paused: every clock, timer and offset stays where it is, so stanceOffset(), toeRaise() and apply() hold the
    // same pose tick after tick (freezing rather than resetting, which would make the body jump once).
    if (this.paused) return;
    const fps = 60;
    this.t += 1 / fps;
    this.engagedBlend += ((engaged ? 1 : 0) - this.engagedBlend) * 0.05;
    this.bouncePhase += (Math.PI * 2 * this.style.bounceHz * this.mods.bounceHz * (0.35 + 0.65 * this.engagedBlend)) / fps;

    for (const k of ['feint', 'paw'] as const) {
      const b = this[k];
      if (b && ++b.t >= b.dur) this[k] = null;
    }

    const free = engaged && still && !this.feint;
    if (free && this.mods.feints > 0.02 && (this.feintTimer -= this.mods.feints) <= 0) {
      const w = this.style.feintWeights;
      const kind = this.rng.pickWeighted<FeintKind>([
        ['jab', w.jab],
        ['shoulder', w.shoulder],
        ['level', w.level],
        ['step', w.step],
      ]);
      this.feint = { kind, t: 0, dur: FEINT_FRAMES[kind] };
      this.feints++;
      this.feintTimer = Math.round(this.rng.range(...this.style.feintEvery) * fps);
    }
    if (free && !this.paw && this.mods.paws > 0.02 && (this.pawTimer -= this.mods.paws) <= 0) {
      this.paw = { t: 0, dur: 14 };
      this.pawTimer = Math.round(this.rng.range(...this.style.pawEvery) * fps);
    }
    if (engaged && still) {
      if (--this.shuffleTimer <= 0) {
        this.offTarget = [this.rng.range(-0.09, 0.09), this.rng.range(-0.12, 0.12)];
        this.shuffles++;
        this.shuffleTimer = Math.round(this.rng.range(...this.style.shuffleEvery) * fps);
      }
    } else {
      this.offTarget = [0, 0];
    }
    this.off[0] += (this.offTarget[0] - this.off[0]) * 0.2;
    this.off[1] += (this.offTarget[1] - this.off[1]) * 0.2;
  }

  /** Extra stance offset for the feet (re-stancing + step feints). */
  stanceOffset(): [number, number] {
    let z = this.off[1];
    if (this.feint?.kind === 'step') z += 0.17 * snapEnv(this.feint.t / this.feint.dur);
    return [this.off[0], z];
  }

  /** Ankle raise from bouncing on the toes. */
  toeRaise(): number {
    return Math.abs(Math.sin(this.bouncePhase)) * this.style.bounceAmp * this.mods.bounce * 0.6 * this.engagedBlend;
  }

  /** Layers the idle motion onto a locomotion pose spec. `still` 0..1 fades the idle-only parts. */
  apply(spec: PoseSpec, still: number) {
    const s = this.style;
    const M = this.mods;
    const t = this.t;
    const e = this.engagedBlend;
    const bounce = (Math.abs(Math.sin(this.bouncePhase)) - 0.5) * s.bounceAmp * M.bounce * (0.4 + 0.6 * e);
    const swayX = (s.swayAmp * M.sway * (Math.sin(t * 0.9) + 0.5 * Math.sin(t * 2.3 + 1))) / 1.5;
    const swayZ = (s.swayAmp * M.sway * (Math.sin(t * 0.7 + 2) + 0.5 * Math.sin(t * 1.9))) / 1.5;
    const scan = (0.1 * Math.sin(t * 0.75 + 2) + 0.04 * Math.sin(t * 2.1)) * M.head;
    const roll = s.shoulderRoll * Math.sin(t * 1.4);

    spec.root = add(spec.root, [swayX * still, bounce, swayZ * still]);
    spec.abdomen = add(spec.abdomen, [0.02 * Math.sin(t * 1.1), 0, -swayX * 0.9 * still]);
    spec.chest = add(spec.chest, [0, scan * e + roll, roll * 0.5]);
    // Head keeps eyes on the opponent: counter the torso scan, add small slips.
    spec.head = add(spec.head, [0.04 * Math.sin(t * 1.7) * M.head, -scan * e * 0.7, 0.05 * Math.sin(t * 1.3 + 1) * e * M.head]);
    const handBob = bounce * 0.6;
    spec.handL = addHand(spec.handL, [0.012 * Math.sin(t * 3.1), handBob + 0.01 * Math.cos(t * 3.1), 0.015 * Math.sin(t * 2.2)]);
    spec.handR = addHand(spec.handR, [0.01 * Math.sin(t * 2.7 + 1), handBob + 0.01 * Math.cos(t * 2.7), 0.012 * Math.sin(t * 1.8 + 2)]);

    if (this.paw) {
      const k = Math.sin((this.paw.t / this.paw.dur) * Math.PI) * still;
      spec.handL = addHand(spec.handL, [-0.02 * k, 0.02 * k, 0.15 * k]);
      spec.chest = add(spec.chest, [0, -0.06 * k, 0]);
    }

    if (this.feint) {
      const k = snapEnv(this.feint.t / this.feint.dur) * still;
      switch (this.feint.kind) {
        case 'jab':
          spec.handL = addHand(spec.handL, [-0.04 * k, 0.04 * k, 0.33 * k]);
          spec.chest = add(spec.chest, [0.02 * k, -0.14 * k, 0]);
          spec.pelvis = add(spec.pelvis, [0, -0.06 * k, 0]);
          spec.root = add(spec.root, [0, -0.02 * k, 0.05 * k]);
          break;
        case 'shoulder':
          spec.chest = add(spec.chest, [0.05 * k, 0.3 * k, 0]);
          spec.abdomen = add(spec.abdomen, [0.1 * k, 0, 0]);
          spec.head = add(spec.head, [0, -0.2 * k, 0]);
          spec.root = add(spec.root, [0, -0.035 * k, 0.02 * k]);
          spec.handR = addHand(spec.handR, [0.03 * k, -0.02 * k, 0.1 * k]);
          break;
        case 'level':
          spec.root = add(spec.root, [0, -0.13 * k, 0.02 * k]);
          spec.abdomen = add(spec.abdomen, [0.22 * k, 0, 0]);
          spec.head = add(spec.head, [-0.18 * k, 0, 0]);
          spec.handL = addHand(spec.handL, [0, -0.12 * k, 0]);
          spec.handR = addHand(spec.handR, [0, -0.12 * k, 0]);
          break;
        case 'step':
          spec.root = add(spec.root, [0, -0.02 * k, 0.07 * k]);
          spec.abdomen = add(spec.abdomen, [0.07 * k, 0, 0]);
          spec.handL = addHand(spec.handL, [0, 0, 0.06 * k]);
          break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Save record (docs/M1-DESIGN.md §8.3, P04; MAP gap-7 §3.5, §3.7)
  // ---------------------------------------------------------------------------

  /**
   * Idle life's clocks, timers, bursts and offsets (MAP gap-7 §3.5's Save list), plus `mods`: the fighter copies its
   * motion profile into them every updatePose except while idle life is paused (`Fighter.idlePaused`, P02a), when
   * they hold the amplitudes from before the pause and apply() still reads them, so they are state. `paused` is set
   * from the fighter before every tick and `rng` is the fighter's own (restored with it), so neither is here.
   */
  toRecord(): IdleRecord {
    const f = this.feint;
    const p = this.paw;
    const m = this.mods;
    return {
      feint: f ? { kind: f.kind, t: f.t, dur: f.dur } : null,
      paw: p ? { t: p.t, dur: p.dur } : null,
      t: this.t,
      bouncePhase: this.bouncePhase,
      engagedBlend: this.engagedBlend,
      feintTimer: this.feintTimer,
      shuffleTimer: this.shuffleTimer,
      pawTimer: this.pawTimer,
      off: [this.off[0], this.off[1]],
      offTarget: [this.offTarget[0], this.offTarget[1]],
      feints: this.feints,
      shuffles: this.shuffles,
      mods: { bounce: m.bounce, bounceHz: m.bounceHz, sway: m.sway, head: m.head, feints: m.feints, paws: m.paws },
    };
  }

  /**
   * Puts back a toRecord() state. Constructing the fighter drew `t` and `bouncePhase` from its Rng (MAP gap-7 §3.7):
   * they are overwritten here, and the Rng's own state is restored with the fighter's.
   */
  restoreRecord(r: IdleRecord) {
    const n = numFromRecord;
    this.feint = r.feint ? { kind: r.feint.kind, t: n(r.feint.t, 'idle.feint.t'), dur: n(r.feint.dur, 'idle.feint.dur') } : null;
    this.paw = r.paw ? { t: n(r.paw.t, 'idle.paw.t'), dur: n(r.paw.dur, 'idle.paw.dur') } : null;
    this.t = n(r.t, 'idle.t');
    this.bouncePhase = n(r.bouncePhase, 'idle.bouncePhase');
    this.engagedBlend = n(r.engagedBlend, 'idle.engagedBlend');
    this.feintTimer = n(r.feintTimer, 'idle.feintTimer');
    this.shuffleTimer = n(r.shuffleTimer, 'idle.shuffleTimer');
    this.pawTimer = n(r.pawTimer, 'idle.pawTimer');
    this.off = [n(r.off[0], 'idle.off[0]'), n(r.off[1], 'idle.off[1]')];
    this.offTarget = [n(r.offTarget[0], 'idle.offTarget[0]'), n(r.offTarget[1], 'idle.offTarget[1]')];
    this.feints = n(r.feints, 'idle.feints');
    this.shuffles = n(r.shuffles, 'idle.shuffles');
    const m = this.mods;
    m.bounce = n(r.mods.bounce, 'idle.mods.bounce');
    m.bounceHz = n(r.mods.bounceHz, 'idle.mods.bounceHz');
    m.sway = n(r.mods.sway, 'idle.mods.sway');
    m.head = n(r.mods.head, 'idle.mods.head');
    m.feints = n(r.mods.feints, 'idle.mods.feints');
    m.paws = n(r.mods.paws, 'idle.mods.paws');
  }
}

/** IdleBehavior's saved state (IdleBehavior.toRecord). */
export type IdleRecord = {
  feint: { kind: FeintKind; t: number; dur: number } | null;
  paw: { t: number; dur: number } | null;
  t: number;
  bouncePhase: number;
  engagedBlend: number;
  feintTimer: number;
  shuffleTimer: number;
  pawTimer: number;
  off: [number, number];
  offTarget: [number, number];
  feints: number;
  shuffles: number;
  mods: { bounce: number; bounceHz: number; sway: number; head: number; feints: number; paws: number };
};
