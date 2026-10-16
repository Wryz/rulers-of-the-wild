import { DEV } from '../dev';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ACESFilmicToneMapping,
  Group,
  Mesh,
  MeshBasicMaterial,
  PCFShadowMap,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { THEMES, type ThemeDef, type ThemeId } from '../arena/themes';
import { ThemeView } from '../arena/themeView';
import { GROUP_ENV, groups, Ragdoll } from '../body/ragdoll';
import { BONES } from '../body/skeleton';
import { type Material, Sfx, type Surface } from '../feel/audio';
import { Input } from '../input/input';
import { CAMERA_TUNING, CameraRig } from '../render/cameraRig';
import { Blood } from '../render/blood';
import { Gibs } from '../render/gibs';
import { Coins } from '../render/coins';
import { cutoutUniforms, updateCutout } from '../render/cutout';
import { Effects } from '../render/particles';
import { FighterView, type GearLook, PLAYER_PALETTE, type Palette } from '../render/fighterView';
import { lookFor } from '../render/looks';
import { DEFAULT_AI, type AIConfig } from '../sim/ai';
import { buttonMove, type CombatEvent, CombatSim, type Fatal, PARRY_WINDOW, PERFECT_DODGE, type HurtZone, hurtSpheres, strikePoint, type Tear } from '../sim/combat';
import { DEFENSES, type MoveDef, moveLength } from '../sim/moves';
import { ARCHETYPES, coinDrop, createEnemy, type EnemyKind, type EnemyMods } from '../sim/enemies';
import { type Button, DEFAULT_STATS, type Fighter, type FighterStats } from '../sim/fighter';
import { DT, Rng } from '../sim/math';
import { createPlayer } from '../sim/roster';
import { BattleLog } from '../ui/battleLog';
import { DeathScreen, type RunSummary } from '../ui/death';
import { Hud } from '../ui/hud';
import { keyLabel } from '../input/bindings';
import { SettingsMenu } from '../ui/settings';
import { Shop } from '../ui/shop';
import { ArenaWalkable } from '../world/collision';
import type { Drop } from '../sim/combat';
import { limbBones, WEAPONS, type Wound } from '../sim/weapons';
import { DropView, ProjectileView } from '../render/weaponView';
import { projectileDir, projectileGrip } from '../sim/projectiles';
import { Cinematics, type Shot } from '../render/cinematics';
import { OUTFITS, SUPPLIES } from './catalog';
import { BattleRecorder } from './recorder';
import { deathRewardParts, item, loadSave, NO_BUFFS, opponentGear, type RoundBuffs, type SaveData, SLOTS, staminaRegen, statsWithGear, useSupplies, writeSave } from './economy';
import { type RoundSpec, roundSpec, type Spawn } from './gauntlet';
import { Trauma } from './trauma';

/** One run of the gauntlet, from round 1 until you fall. */
export interface RunStats {
  kos: number;
  hits: number;
  damage: number;
  bestCombo: number;
  perfect: number;
  /** Skulls split / cleft / crushed and heads taken. */
  brutal: number;
  started: number;
  killedBy: string;
}

function newRun(): RunStats {
  return { kos: 0, hits: 0, damage: 0, bestCombo: 0, perfect: 0, brutal: 0, started: performance.now(), killedBy: '' };
}

export const GAME_TUNING = {
  timeScale: 1,
  paused: false,
  hitstopMul: 1,
  showHitboxes: false,
  volume: 0.7,
};

const TIME_SCALES = [1, 0.5, 0.25, 0.1];
/** What a blunt weapon sounds like when it lands. */
const IMPACT: Partial<Record<string, Material>> = { pan: 'pan', chair: 'metal', crowbar: 'metal', pipe: 'metal', sledgehammer: 'metal', bottle: 'glass' };
/** What each arena's floor is, for footsteps. */
const FLOOR: Record<ThemeId, Surface> = { ring: 'canvas', street: 'asphalt', grocery: 'tile', colosseum: 'sand', warehouse: 'concrete', bar: 'wood', dojo: 'wood', rooftop: 'gravel' };
const PLAYER_BASE: FighterStats = { ...DEFAULT_STATS, maxHp: 100, walkSpeed: 2.6 };
/** Enemies stand still for this long while the round is announced (real seconds). */
const INTRO_HOLD = 1.6;
const _los = new Vector3();
/** Weapons that knock (wood) rather than ring (metal, glass) when they hit the floor. */
const WOODEN = new Set(['bat', 'club', 'bokken', 'cue']);

type Mode = 'gauntlet' | 'training';
type Phase = 'play' | 'clear' | 'shop' | 'down';

const TORSO = ['chest', 'abdomen', 'head'] as const;
const _edge = new Vector3();
const _grip = new Vector3();

export class Game {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camRig = new CameraRig();
  /** Camera cuts for the big moments. */
  readonly cine = new Cinematics();
  private readonly lastHitBy = new Map<Fighter, Fighter>();
  readonly effects: Effects;
  readonly coins: Coins;
  readonly blood: Blood;
  readonly gibs: Gibs;
  readonly trauma = new Map<Fighter, Trauma>();
  readonly sfx = new Sfx();
  readonly input: Input;
  readonly hud: Hud;
  readonly settings: SettingsMenu;
  readonly shop: Shop;
  readonly world: RAPIER.World;
  readonly sim: CombatSim;
  readonly aiCfg: AIConfig = { ...DEFAULT_AI };
  readonly player: Fighter;
  readonly mode: Mode;
  readonly save: SaveData;
  /** All live (and recently KO'd) enemies. */
  readonly enemies: Fighter[] = [];
  private readonly enemyKind = new Map<Fighter, EnemyKind>();
  private readonly telegraphed = new Map<Fighter, number>();
  private readonly koAt = new Map<Fighter, number>();

  // Arena.
  theme: ThemeDef = THEMES.ring;
  private themeView: ThemeView | null = null;
  private envBody: RAPIER.RigidBody | null = null;

  // Gauntlet.
  /** Current round. */
  round = 0;
  spec: RoundSpec | null = null;
  private readonly roundRng = new Rng((Date.now() & 0xffff) + 7);
  private holdIn = -1;
  private clearIn = -1;
  private nextRoundIn = -1;

  // Training.
  wave = 1;
  kos = 0;
  private respawnIn = -1;

  private phase: Phase = 'play';
  private readonly fxRng = new Rng(99);
  private readonly views = new Map<Fighter, FighterView>();
  private readonly dropViews = new Map<number, DropView>();
  /** Weapons in the air. */
  private readonly projViews = new Map<number, ProjectileView>();
  /** Who was in the air last step (to hear them land). */
  private readonly airborne = new Set<Fighter>();
  private shownWounds = new WeakSet<Wound>();
  /** How sweaty each fighter has got this round (0..1). */
  private readonly sweat = new Map<Fighter, number>();
  private readonly ragdolls = new Map<Fighter, Ragdoll>();
  private hitstop = 0;
  private hitstopVictim: Fighter | null = null;
  private accum = 0;
  private stepOnce = false;
  private slowmo = 0;
  private downIn = -1;
  /** What the last run paid out when it ended. */
  private lastPay = 0;
  private recorder!: BattleRecorder;
  private battleLog!: BattleLog;
  /** Supplies in use this round. */
  private buffs: RoundBuffs = NO_BUFFS;
  private wornOutfit: string | null = null;
  private runSummary: RunSummary | null = null;
  private readonly death: DeathScreen;
  /** This run so far (since the last round 1), for the end-of-run screen. */
  run: RunStats = newRun();
  private shopIn = -1;
  private bannerIn = -1;
  private attacksThrown = 0;
  private time = 0;
  /** Game time: runs with the slow-motion, stops for pauses and hitstop. */
  private simClock = 0;
  private pausedBySettings = false;
  /** Exposed for the developer panel and automated capture scripts (developer mode). */
  readonly tuning = GAME_TUNING;
  readonly cameraTuning = CAMERA_TUNING;
  readonly cutout = cutoutUniforms;
  onTogglePanel: (() => void) | null = null;

  private readonly debugGroup = new Group();
  private readonly debugPool: Mesh[] = [];
  private readonly debugMats = {
    hurt: new MeshBasicMaterial({ color: 0x40ff80, wireframe: true, transparent: true, opacity: 0.5 }),
    strike: new MeshBasicMaterial({ color: 0xff3030, wireframe: true }),
    target: new MeshBasicMaterial({ color: 0x40d0ff }),
  };
  private readonly sphereGeo = new SphereGeometry(1, 10, 8);

  static async create(canvas: HTMLCanvasElement, hudRoot: HTMLElement): Promise<Game> {
    await RAPIER.init();
    return new Game(canvas, hudRoot);
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    hudRoot: HTMLElement,
  ) {
    const r = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = SRGBColorSpace;
    this.renderer = r;
    this.effects = new Effects(this.scene);
    this.coins = new Coins(this.scene);
    this.blood = new Blood(this.scene);
    this.gibs = new Gibs(this.scene);
    this.scene.add(this.debugGroup);
    const params = new URLSearchParams(location.search);
    this.mode = DEV && (params.get('mode') === 'training' || params.get('mode') === 'arena') ? 'training' : 'gauntlet';
    this.save = loadSave();

    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = DT;
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0).setFriction(0.9).setCollisionGroups(groups(GROUP_ENV, 0xffff)),
      ground,
    );

    this.sim = new CombatSim((Date.now() & 0xffff) + 1);
    this.sim.externalKnockdown = true;

    this.player = createPlayer();
    this.sim.add(this.player);
    this.attach(this.player, PLAYER_PALETTE);

    this.input = new Input(canvas);
    this.input.onAnyInput = () => this.sfx.unlock();
    this.hud = new Hud(hudRoot);
    this.hud.setBindings(this.input.bindings);
    this.settings = new SettingsMenu(document.body, this.input);
    this.settings.onChange = (b) => this.hud.setBindings(b);
    this.blood.enabled = this.settings.prefs.blood;
    this.settings.onPrefs = (p) => {
      this.blood.enabled = p.blood;
      if (this.recorder) this.recorder.enabled = p.record;
      if (!p.blood) {
        this.blood.clear();
        this.gibs.clear();
      }
    };
    this.settings.onOpenChange = (open) => this.setMenuPause(open);
    this.hud.gearButton.addEventListener('click', () => this.settings.toggle());
    // The battle log: every battle on video.
    this.recorder = new BattleRecorder(this.renderer.domElement);
    this.recorder.enabled = this.settings.prefs.record;
    this.battleLog = new BattleLog(document.body, this.recorder);
    this.battleLog.onClose = () => {
      // (Back to whatever it was opened over: the shop or the defeat screen stay paused.)
      if (!this.shop.isOpen && !this.death.isOpen && this.phase !== 'shop') this.setMenuPause(false);
    };
    this.hud.logButton.addEventListener('click', () => this.openLog());
    this.shop = new Shop(document.body, this.save);
    this.death = new DeathScreen(document.body);
    this.death.onTick = () => this.sfx.coin();
    this.death.onShop = () => {
      this.hud.setCoins(this.save.coins, false);
      this.shop.open(this.round, this.lastPay);
    };
    this.death.onReplay = () => this.openLog();
    this.shop.onReplay = () => this.openLog();
    this.death.onAgain = () => {
      this.hud.setCoins(this.save.coins, false);
      this.setMenuPause(false);
      this.startRound(1);
    };
    this.shop.onBuy = () => {
      writeSave(this.save);
      this.applyGear();
      this.hud.setCoins(this.save.coins, false);
      this.sfx.coin();
    };
    this.shop.onDenied = () => this.sfx.block(false);
    this.shop.stats = () => this.player.stats;
    this.shop.onDone = () => {
      this.shop.close();
      this.setMenuPause(false);
      // (After a death the run starts over.)
      this.startRound(this.shop.fallen ? 1 : this.round + 1);
    };

    this.applyGear();
    if (this.mode === 'training') this.setupTraining();
    else this.startRound(1);
    this.hud.setCoins(this.save.coins, false);
    this.hud.showCoins(this.mode === 'gauntlet');

    this.cine.onChange = (on) => this.hud.cinematic(on);
    // Cut cameras keep a clear line to the action: no shooting through a column, a car
    // or a shelf, and never from out in the stands.
    this.cine.blocked = (cam, look) => {
      const w = this.sim.walkable;
      if (!w.isWalkable(cam.x, cam.z)) return true;
      for (let i = 1; i < 12; i++) {
        _los.lerpVectors(cam, look, i / 12);
        if (w.solidAt?.(_los, 0.12)) return true;
      }
      return false;
    };
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get enemy(): Fighter | null {
    return this.enemies.find((e) => e.alive) ?? this.enemies[0] ?? null;
  }

  setMenuPause(open: boolean) {
    // Pause while a menu is open (unless already paused for tuning).
    if (open && !GAME_TUNING.paused) {
      GAME_TUNING.paused = true;
      this.pausedBySettings = true;
    } else if (!open && this.pausedBySettings) {
      GAME_TUNING.paused = false;
      this.pausedBySettings = false;
    }
  }

  /** Everything bought, applied: gear, training, skills, this round's supplies, the outfit. */
  applyGear() {
    const p = this.player;
    const hpFrac = p.hp / p.stats.maxHp;
    p.stats = statsWithGear(this.save, PLAYER_BASE, this.buffs);
    p.hp = Math.min(p.stats.maxHp, Math.max(1, hpFrac * p.stats.maxHp));
    p.staminaRegenMul = staminaRegen(this.save, this.buffs);
    p.weaponDamageMul = 1 + this.buffs.weaponDamageMul;
    p.perks = new Set(this.save.skills);
    if (this.buffs.lastStand) p.perks.add('lastStand');
    this.applyOutfit();
    this.applyGearLook();
  }

  /** Worn armour, shown on the body. */
  private applyGearLook() {
    const look: GearLook = {};
    for (const slot of SLOTS) {
      const g = item(slot, this.save.gear[slot]);
      if (g) look[slot] = { material: g.material, tier: g.tier };
    }
    this.views.get(this.player)?.setGear(look);
  }

  // ---------------------------------------------------------------------------
  // Fighters
  // ---------------------------------------------------------------------------

  private attach(f: Fighter, palette: Palette, look?: GearLook) {
    const view = new FighterView(palette);
    if (look) view.setGear(look);
    view.setScale(f.scale);
    this.scene.add(view.root);
    this.views.set(f, view);
    this.ragdolls.set(f, new Ragdoll(RAPIER, this.world, f));
  }

  private detach(f: Fighter) {
    const v = this.views.get(f);
    if (v) this.scene.remove(v.root);
    this.ragdolls.get(f)?.dispose();
    this.views.delete(f);
    this.ragdolls.delete(f);
    this.sim.remove(f);
    const i = this.enemies.indexOf(f);
    if (i >= 0) this.enemies.splice(i, 1);
    this.enemyKind.delete(f);
    this.telegraphed.delete(f);
    this.koAt.delete(f);
    this.trauma.delete(f);
    this.falls.delete(f);
    this.airborne.delete(f);
  }

  private spawn(kind: EnemyKind, x: number, z: number, mods: EnemyMods & Partial<Spawn> = {}, fx = true): Fighter {
    const training = this.mode === 'training';
    const { fighter, ai } = createEnemy(kind, this.sim.rng, mods, training ? this.aiCfg : {});
    if (training) ai.cfg = this.aiCfg;
    // Geared up for the round: the same armour you can buy, and maybe a weapon.
    if (mods.gear) {
      fighter.stats = opponentGear(fighter.stats, mods.gear);
      fighter.hp = fighter.stats.maxHp;
    }
    if (mods.weapon && !fighter.weapon) fighter.weapon = WEAPONS[mods.weapon];
    fighter.pos.set(x, 0, z);
    fighter.yaw = Math.atan2(this.player.pos.x - x, this.player.pos.z - z);
    fighter.updatePose(0, 0, 0);
    this.sim.add(fighter, ai);
    const look = lookFor(kind, this.theme.id);
    const worn: GearLook = { ...look.gear };
    for (const slot of SLOTS) {
      const g = item(slot, mods.gear?.[slot] ?? 0);
      if (g) worn[slot] = { material: g.material, tier: g.tier };
    }
    this.attach(fighter, look.palette, worn);
    this.ragdolls.get(fighter)?.snapTo(fighter);
    this.enemies.push(fighter);
    this.enemyKind.set(fighter, kind);
    if (fx) {
      if (this.cues) this.effects.ring(fighter.pos, 1.2 * fighter.scale, '#ff5040', 0.6);
      this.effects.dust(fighter.pos, 14, 0.6 * fighter.scale);
    }
    return fighter;
  }

  private clearEnemies() {
    for (const e of [...this.enemies]) this.detach(e);
  }

  /** Coins are worth more with Fortune, and double with a Lucky Coin. */
  private get coinMul(): number {
    return this.buffs.coinMul * (this.save.skills.includes('fortune') ? 1.3 : 1);
  }

  /** The outfit chosen in the shop (the body is rebuilt in its colours). */
  private applyOutfit() {
    const o = OUTFITS.find((x) => x.id === this.save.outfit) ?? OUTFITS[0];
    if (this.wornOutfit === o.id) return;
    this.wornOutfit = o.id;
    const p = this.player;
    const old = this.views.get(p);
    if (!old) return;
    const view = new FighterView({ ...PLAYER_PALETTE, ...o.colors });
    view.setScale(p.scale);
    this.scene.remove(old.root);
    this.scene.add(view.root);
    this.views.set(p, view);
    this.shownWounds = new WeakSet();
    this.applyGearLook();
  }

  private resetPlayer(x: number, z: number, yaw: number) {
    const p = this.player;
    p.perksUsed.clear();
    p.pos.set(x, 0, z);
    p.yaw = yaw;
    p.vel.set(0, 0, 0);
    p.walkVel.set(0, 0, 0);
    p.hp = p.stats.maxHp;
    p.guard = p.stats.maxGuard;
    p.poise = p.stats.maxPoise;
    p.counter = null;
    p.buffer = null;
    // Patched up between rounds: wounds healed, everything reattached, empty-handed.
    p.wounds.length = 0;
    p.severed.clear();
    p.torn.clear();
    for (const k of Object.keys(p.limbDamage)) delete p.limbDamage[k as keyof typeof p.limbDamage];
    p.weapon = null;
    p.pickupRequest = 0;
    this.views.get(p)?.clearWounds();
    this.views.get(p)?.clean();
    this.sweat.delete(p);
    p.enterLocomotion(1);
    p.updatePose(0, 0, 0);
    const rd = this.ragdolls.get(p);
    if (rd && rd.loose.size) {
      rd.dispose();
      this.ragdolls.set(p, new Ragdoll(RAPIER, this.world, p));
    } else rd?.snapTo(p);
  }

  /** Weapons scattered around the arena at the start of a round. */
  private scatterWeapons() {
    const spots = [...this.theme.weaponSpots];
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(this.roundRng.next() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    this.theme.weapons.forEach((id, i) => {
      const [x, z] = spots[i % spots.length];
      this.sim.addDrop(WEAPONS[id], x, z, this.roundRng.range(0, Math.PI * 2));
    });
    // The drops' events are picked up on the next sim step.
    this.syncDropViews();
  }

  private clearDrops() {
    this.sim.drops.length = 0;
    this.sim.projectiles.length = 0;
    this.syncDropViews();
    this.syncProjectiles();
  }

  /** One model per weapon in flight, placed from its rigid body. */
  private syncProjectiles() {
    const live = new Set(this.sim.projectiles.map((p) => p.id));
    for (const [id, v] of this.projViews) {
      if (live.has(id)) continue;
      v.dispose();
      this.projViews.delete(id);
    }
    for (const p of this.sim.projectiles) {
      let v = this.projViews.get(p.id);
      if (!v) {
        v = new ProjectileView(p.weapon, p.scale);
        this.scene.add(v.root);
        this.projViews.set(p.id, v);
      }
      const dir = projectileDir(p).clone();
      // The edge faces the way the head turns (end over end); a knife's is just up.
      const edge = p.omega > 0 ? _edge.crossVectors(p.axis, dir) : _edge.set(0, 1, 0);
      v.place(projectileGrip(p, _grip), dir, edge);
    }
  }

  /** Keeps one floor model per weapon lying around. */
  private syncDropViews() {
    const live = new Set(this.sim.drops.map((d) => d.id));
    for (const [id, v] of this.dropViews) {
      if (live.has(id)) continue;
      v.dispose();
      this.dropViews.delete(id);
    }
    for (const d of this.sim.drops) {
      if (this.dropViews.has(d.id)) continue;
      const v = new DropView(d.weapon, d.pos.x, d.pos.z, d.yaw);
      this.scene.add(v.root);
      this.dropViews.set(d.id, v);
      // Let go of mid-air: it falls, and you hear it hit the floor.
      if (d.from) {
        const w = d.weapon;
        const at = d.pos.clone();
        v.fall(d.from, (hard) => {
          this.sfx.landing(w.mass, !WOODEN.has(w.id), hard);
          this.effects.dust(at, Math.round(2 + 3 * hard * Math.min(2, w.mass / 2)), 0.08 + 0.04 * w.mass);
        });
      }
    }
  }

  /** Debug: put a weapon straight into the player's hands. */
  giveWeapon(id: keyof typeof WEAPONS | null) {
    this.player.weapon = id ? WEAPONS[id] : null;
  }

  /** The weapon the player could grab right now. */
  private dropInReach(): Drop | null {
    const p = this.player;
    let best: Drop | null = null;
    let bd = 1.15 * p.scale;
    for (const d of this.sim.drops) {
      const dist = Math.hypot(d.pos.x - p.pos.x, d.pos.z - p.pos.z);
      if (dist < bd) {
        bd = dist;
        best = d;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Arena
  // ---------------------------------------------------------------------------

  /** Swaps the arena: visuals, walkable area and the static colliders that keep ragdolls in. */
  private setTheme(id: ThemeId) {
    const def = THEMES[id];
    this.theme = def;
    this.themeView?.dispose();
    this.themeView = new ThemeView(this.scene, def, (Date.now() & 0xffff) + this.round * 131);
    this.scene.background = this.themeView.background;
    this.sfx.setAmbience(def.id);
    this.sim.walkable = new ArenaWalkable(def.shape, def.obstacles);

    if (this.envBody) this.world.removeRigidBody(this.envBody);
    const env = groups(GROUP_ENV, 0xffff);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.envBody = body;
    const wall = (x: number, z: number, hx: number, hz: number, ry = 0) => {
      const d = RAPIER.ColliderDesc.cuboid(hx, 2, hz).setTranslation(x, 2, z).setCollisionGroups(env);
      if (ry) d.setRotation({ x: 0, y: Math.sin(ry / 2), z: 0, w: Math.cos(ry / 2) });
      this.world.createCollider(d, body);
    };
    const s = def.shape;
    if (s.kind === 'rect') {
      wall(0, -s.hz - 0.45, s.hx + 1, 0.2);
      wall(0, s.hz + 0.45, s.hx + 1, 0.2);
      wall(-s.hx - 0.45, 0, 0.2, s.hz + 1);
      wall(s.hx + 0.45, 0, 0.2, s.hz + 1);
    } else {
      const n = 28;
      const R = s.r + 0.45;
      const half = (Math.PI * R) / n + 0.1;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        wall(Math.sin(a) * R, Math.cos(a) * R, half, 0.2, a);
      }
    }
    for (const o of def.obstacles) {
      const d =
        o.kind === 'circle'
          ? RAPIER.ColliderDesc.cylinder(1.2, o.r).setTranslation(o.x, 1.2, o.z)
          : RAPIER.ColliderDesc.cuboid(o.hx, 0.8, o.hz).setTranslation(o.x, 0.8, o.z);
      this.world.createCollider(d.setCollisionGroups(env), body);
    }
    cutoutUniforms.uCutOn.value = 1;
  }

  /** Clears the floor of the last fight. */
  private resetArena() {
    this.cine.stop();
    this.hud.mood('');
    this.lastHitBy.clear();
    this.sweat.clear();
    this.clearEnemies();
    this.clearDrops();
    this.coins.clear();
    this.blood.clear();
    this.gibs.clear();
    this.trauma.clear();
    this.views.get(this.player)?.setTrauma(0, false);
    this.player.minHp = 0;
    this.holdIn = this.clearIn = this.nextRoundIn = this.downIn = this.shopIn = this.respawnIn = -1;
    this.slowmo = 0;
    this.hud.hideBanner();
    this.hud.prompt('');
    this.phase = 'play';
  }

  private placePlayer() {
    const [x, z] = this.theme.playerSpawn;
    this.applyGear();
    // Face the middle of the arena.
    this.resetPlayer(x, z, Math.atan2(-x, -z * 0.3));
    // Walk in with the weapon you've chosen from the rack.
    if (this.save.loadout) this.giveWeapon(this.save.loadout);
    this.camRig.snap(this.player);
  }

  /** Supplies going into this round: " · Health Tonic, War Paint". */
  private suppliesNote(): string {
    if (!this.buffs.used.length) return '';
    return ` · using ${this.buffs.used.map((id) => SUPPLIES.find((x) => x.id === id)!.name).join(', ')}`;
  }

  /** How the opponent comes kitted out: " · tier 3 armour · machete". */
  private kitNote(s: Spawn): string {
    const tiers = Object.values(s.gear).filter((t): t is number => !!t);
    const armour = tiers.length ? ` · tier ${Math.max(...tiers)} armour` : '';
    const w = s.weapon ? ` · ${WEAPONS[s.weapon].name.toLowerCase()}` : '';
    return armour + w;
  }

  private banner(text: string, sub: string, cls = '', secs = 2.2) {
    this.hud.showBanner(text, sub, cls);
    this.bannerIn = secs;
  }

  // ---------------------------------------------------------------------------
  // Gauntlet
  // ---------------------------------------------------------------------------

  /** Round n: new arena, new opponent. */
  startRound(n: number) {
    this.resetArena();
    if (n === 1 || !this.run) this.run = newRun();
    this.runSummary = null;
    // One of each supply in the bag goes into this round.
    this.buffs = this.mode === 'gauntlet' ? useSupplies(this.save) : NO_BUFFS;
    if (this.buffs.used.length) writeSave(this.save);
    this.round = n;
    const spec = roundSpec(n, this.roundRng);
    this.spec = spec;
    this.setTheme(spec.theme);
    this.placePlayer();
    const spots = this.theme.enemySpawns;
    spec.spawns.forEach((s, i) => {
      const [x, z] = spots[i % spots.length];
      const ring = Math.floor(i / spots.length) * 0.8;
      const f = this.spawn(s.kind, x + ring, z, s);
      this.sim.ais.get(f)!.cfg.passive = true;
    });
    this.scatterWeapons();
    // Rolling: this battle goes in the log.
    this.recorder.start({ round: n, arena: this.theme.name, opponent: ARCHETYPES[spec.spawns[0].kind].name, boss: !!spec.boss });
    this.holdIn = INTRO_HOLD;
    this.hud.mood('');
    if (spec.boss) {
      // The giant steps in: low angle, looking up at it.
      const boss = this.enemies[0];
      this.holdIn = INTRO_HOLD + 0.9;
      const toPlayer = new Vector3().subVectors(this.player.pos, boss.pos).setY(0).normalize();
      this.cut({
        focus: () => new Vector3(boss.pos.x, boss.rig.chest.pos.y + 0.15 * boss.scale, boss.pos.z),
        side: toPlayer.applyAxisAngle(new Vector3(0, 1, 0), 0.55),
        distance: 3.3 * boss.scale,
        height: -0.75 * boss.scale,
        orbit: -0.12,
        dolly: -0.35,
        fov: 42,
        duration: 2.4,
        slow: 1,
        priority: 2,
      });
      this.banner(`BOSS · ${ARCHETYPES[spec.boss].name.toUpperCase()}`, `round ${n} · ${this.theme.name}${this.kitNote(spec.spawns[0])}`, 'down', 2.6);
      this.camRig.addTrauma(0.35);
      this.sfx.knockdown();
    } else {
      this.banner(`ROUND ${n}`, `${this.theme.name} · ${ARCHETYPES[spec.spawns[0].kind].name}${this.kitNote(spec.spawns[0])}${this.suppliesNote()}`, 'intro');
    }
    this.setMenuPause(false);
  }

  private updateGauntlet() {
    if (this.phase !== 'play' || !this.spec || this.clearIn >= 0) return;
    if (this.enemies.length > 0 && this.enemies.every((e) => !e.alive)) this.clearIn = 2.3;
  }

  private roundCleared() {
    const spec = this.spec!;
    this.phase = 'clear';
    this.save.bestRound = Math.max(this.save.bestRound, spec.round);
    const p = this.player.pos;
    const reward = Math.round(spec.reward * this.coinMul);
    this.coins.burst(new Vector3(p.x, 1.6, p.z), reward);
    writeSave(this.save);
    this.sfx.chime();
    this.banner(spec.boss ? 'BOSS DOWN' : 'ROUND CLEAR', `+${reward} coins`, 'intro', 2.4);
    this.shopIn = 2.6;
    this.victoryShot();
  }

  /** The winner, arms up, from just below — heroic. */
  private victoryShot() {
    const p = this.player;
    if (!p.alive) return;
    if (p.free) p.celebrate();
    const front = new Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw)).applyAxisAngle(new Vector3(0, 1, 0), 0.6);
    this.cut({
      focus: () => new Vector3(p.pos.x, p.rig.chest.pos.y + 0.1, p.pos.z),
      side: front,
      distance: 2.6,
      height: -0.25,
      orbit: -0.22,
      fov: 40,
      duration: 2.4,
      slow: 1,
      priority: 4,
    });
  }

  // ---------------------------------------------------------------------------
  // Training
  // ---------------------------------------------------------------------------

  private setupTraining() {
    this.resetArena();
    this.setTheme('ring');
    this.placePlayer();
    this.spawnEnemy(true);
    this.scatterWeapons();
  }

  /** Replace the opponent (training), or add a brawler (debug panel "Respawn enemy"). */
  spawnEnemy(first = false) {
    const p = this.player.pos;
    if (this.mode !== 'training') {
      this.spawn('brawler', p.x + 2.5, p.z);
      return;
    }
    this.clearEnemies();
    const [x, z] = first ? this.theme.enemySpawns[0] : [p.x > 0 ? -2.2 : 2.2, -p.z * 0.5];
    const f = this.spawn('brawler', x, z, { hpMul: 1 + 0.12 * (this.wave - 1) }, !first);
    f.name = 'Brawler';
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.camRig.resize(w, h);
    this.cine.resize(w / h);
  }

  /** Game-style readability cues on? (Off by default: realistic presentation.) */
  get cues() {
    return this.settings.prefs.cues;
  }

  /** The camera the frame is seen through (a cut, or the gameplay camera). */
  get viewCamera() {
    return this.cine.active ? this.cine.camera : this.camRig.camera;
  }

  /**
   * Ground direction for a cut that looks across the line between two points, on the
   * side the gameplay camera is already on (so left and right stay where they were).
   */
  private across(a: Vector3, b: Vector3, toward = 0.25): Vector3 {
    const l = new Vector3(b.x - a.x, 0, b.z - a.z);
    if (l.lengthSq() < 1e-6) l.set(1, 0, 0);
    l.normalize();
    const side = new Vector3(l.z, 0, -l.x);
    const cam = this.camRig.camera.position;
    if (side.x * (cam.x - (a.x + b.x) / 2) + side.z * (cam.z - (a.z + b.z) / 2) < 0) side.negate();
    // A little over the shoulder of whoever is at `a`.
    return side.addScaledVector(l, -toward).normalize();
  }

  private pelvisOf(f: Fighter): () => Vector3 {
    return () => {
      const p = this.ragdolls.get(f)?.pelvisPos() ?? f.pos.clone();
      p.y = Math.max(0.35 * f.scale, p.y);
      return p;
    };
  }

  private cut(shot: Shot) {
    this.cine.play(shot);
  }

  start() {
    let last = performance.now();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.frame(dt);
    };
    requestAnimationFrame(loop);
  }

  requestStep() {
    this.stepOnce = true;
  }

  /** Debug/capture helper: run `n` fixed steps immediately (rendered on the next frame). */
  advance(n: number) {
    for (let i = 0; i < n; i++) this.fixedStep();
  }

  restart() {
    this.shop.close();
    if (this.mode === 'gauntlet') {
      this.startRound(Math.max(1, this.round));
      return;
    }
    this.wave = 1;
    this.kos = 0;
    this.resetArena();
    this.placePlayer();
    this.spawnEnemy(true);
    this.scatterWeapons();
  }

  /** Debug/capture helper: place the player and the first enemy `dist` apart, facing each other. */
  stage(dist: number) {
    const e = this.enemy;
    const p = this.player;
    p.pos.set(-dist / 2, 0, 0);
    p.yaw = Math.PI / 2;
    p.hp = p.stats.maxHp;
    p.enterLocomotion(1);
    p.updatePose(0, 0, 0);
    this.ragdolls.get(p)?.snapTo(p);
    if (e) {
      e.pos.set(dist / 2, 0, 0);
      e.yaw = -Math.PI / 2;
      e.hp = e.stats.maxHp;
      e.enterLocomotion(1);
      e.updatePose(0, 0, 0);
      this.ragdolls.get(e)?.snapTo(e);
    }
    this.hitstop = 0;
    this.camRig.snap(this.player);
  }

  private revivePlayer() {
    const p = this.player;
    p.hp = p.stats.maxHp;
    p.guard = p.stats.maxGuard;
    p.poise = p.stats.maxPoise;
    p.counter = null;
    p.vel.set(0, 0, 0);
    if (p.state === 'ko' || p.state === 'knockdown') p.enterGetup();
  }

  private frame(realDt: number) {
    this.time += realDt;
    const inp = this.input.poll();
    this.recorder?.tick(GAME_TUNING.paused);
    for (const k of inp.keys) this.metaKey(k);

    const fwd = this.camRig.groundForward;
    const right = this.camRig.groundRight;
    const blocked = this.phase === 'shop' || this.phase === 'down' || this.settings.isOpen || this.battleLog?.isOpen;
    this.player.moveInput.set(
      blocked ? 0 : right.x * inp.moveX + fwd.x * inp.moveY,
      0,
      blocked ? 0 : right.z * inp.moveX + fwd.z * inp.moveY,
    );
    for (const b of inp.presses) {
      if (!this.player.alive || blocked) continue;
      this.player.press(b);
      if (++this.attacksThrown === 8) this.hud.fadeHint();
    }
    if (inp.pickup && this.player.alive && !blocked && this.player.state !== 'pickup') this.player.pickupRequest = 12;

    // Timers in real time (stopped while paused).
    if (!GAME_TUNING.paused) this.tickTimers(realDt);

    let scale = GAME_TUNING.timeScale * (this.cine.active ? this.cine.timeScale : this.slowmo > 0 ? 0.25 : 1);
    if (GAME_TUNING.paused) scale = 0;
    if (this.stepOnce) {
      this.stepOnce = false;
      this.fixedStep();
    }
    // (A camera cut is already the slow-motion beat: no hit-pause frozen on top of it.)
    if (this.cine.active && this.hitstop > 0) this.hitstop = 0;
    this.accum += realDt * scale;
    let steps = 0;
    while (this.accum >= DT && steps < 6) {
      this.fixedStep();
      this.accum -= DT;
      steps++;
    }
    if (steps === 6) this.accum = 0;
    const frozen = this.hitstop > 0 || scale === 0;
    const alpha = frozen ? 1 : this.accum / DT;
    this.render(realDt, frozen ? 0 : realDt * scale, alpha);
  }

  private tickTimers(dt: number) {
    const due = (t: number) => t > 0 && t - dt <= 0;
    if (this.slowmo > 0) this.slowmo -= dt;
    this.cine.update(dt);
    if (due(this.bannerIn)) this.hud.hideBanner();
    if (due(this.holdIn)) {
      for (const e of this.enemies) {
        const ai = this.sim.ais.get(e);
        if (ai) ai.cfg.passive = false;
      }
    }
    if (due(this.clearIn)) this.roundCleared();
    if (due(this.shopIn)) {
      this.recorder.stop('won');
      this.phase = 'shop';
      this.setMenuPause(true);
      this.shop.open(this.round, null);
    }
    if (due(this.nextRoundIn)) this.startRound(this.round + 1);
    if (due(this.respawnIn)) {
      this.wave++;
      this.spawnEnemy();
      this.hud.hideBanner();
    }
    if (due(this.downIn)) {
      if (this.mode === 'gauntlet') {
        // The run's over: how it went, what it paid — then gear up, or straight back in.
        this.recorder.stop('lost');
        this.hud.hideBanner();
        this.phase = 'shop';
        this.setMenuPause(true);
        if (this.runSummary) this.death.open(this.runSummary);
        else this.shop.open(this.round, this.lastPay);
      } else {
        this.revivePlayer();
        this.phase = 'play';
        this.hud.hideBanner();
        this.hud.mood('');
      }
    }
    for (const k of ['bannerIn', 'holdIn', 'clearIn', 'shopIn', 'nextRoundIn', 'respawnIn', 'downIn'] as const) {
      if (this[k] > 0) this[k] -= dt;
    }
  }

  private metaKey(code: string) {
    switch (code) {
      case 'Escape':
        if (this.phase !== 'shop') this.settings.toggle();
        return;
      case 'KeyM':
        this.sfx.setVolume(this.sfx.volume > 0 ? 0 : GAME_TUNING.volume);
        return;
      case 'KeyB':
        if (!this.settings.isOpen) this.openLog();
        return;
    }
    // Developer keys.
    if (!DEV) return;
    switch (code) {
      case 'KeyL':
        this.onTogglePanel?.();
        break;
      case 'KeyP':
        GAME_TUNING.paused = !GAME_TUNING.paused;
        break;
      case 'Period':
        GAME_TUNING.paused = true;
        this.stepOnce = true;
        break;
      case 'KeyT': {
        const i = TIME_SCALES.indexOf(GAME_TUNING.timeScale);
        GAME_TUNING.timeScale = TIME_SCALES[(i + 1) % TIME_SCALES.length];
        break;
      }
      case 'KeyH':
        GAME_TUNING.showHitboxes = !GAME_TUNING.showHitboxes;
        break;
      case 'Backspace':
        if (this.phase === 'play') this.restart();
        break;
    }
  }

  private fixedStep() {
    if (this.hitstop > 0) {
      this.hitstop--;
      const v = this.hitstopVictim ? this.views.get(this.hitstopVictim) : null;
      if (v) {
        const a = 0.022 * Math.min(1, this.hitstop / 3 + 0.3);
        v.shiver.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a * 0.5, (Math.random() - 0.5) * a);
      }
      for (const rd of this.ragdolls.values()) rd.freezeInterpolation();
      return;
    }
    for (const v of this.views.values()) v.shiver.set(0, 0, 0);

    const events = this.sim.step();
    for (const e of events) this.handleEvent(e);
    this.footsteps();
    this.landings();
    if (this.mode === 'gauntlet') this.updateGauntlet();

    const isDown = (f: Fighter) => f.state === 'knockdown' || f.state === 'ko' || !f.alive;
    let downSlots = 0;
    for (const [f, rd] of this.ragdolls) if (isDown(f)) downSlots |= rd.slot;
    for (const [f, rd] of this.ragdolls) {
      rd.setContacts(isDown(f), downSlots);
      this.slideOff(f, rd);
      rd.drive(f);
      rd.capturePrev();
    }
    this.world.step();
    for (const [f, rd] of this.ragdolls) {
      rd.captureCur();
      this.bodyLanding(f, rd);
      if (f.state === 'knockdown' || f.state === 'ko') {
        const p = rd.pelvisPos();
        f.pos.set(p.x, 0, p.z);
        this.sim.walkable.resolve(f.pos, 0.2);
      }
    }
    // Clear away knocked-out enemies after a while (kept for the round clear check).
    for (const [f, t] of this.koAt) if (this.sim.frame - t > 60 * 6 && this.phase !== 'play') this.detach(f);
  }

  private handleEvent(e: CombatEvent) {
    switch (e.type) {
      case 'hit': {
        const m = e.move;
        const heavy = m.weight === 'heavy';
        const byPlayer = e.attacker.team === 'player';
        if (byPlayer) {
          this.run.hits++;
          this.run.damage += e.damage;
          this.run.bestCombo = Math.max(this.run.bestCombo, e.combo);
          if (e.fatal || e.sever === 'head') this.run.brutal++;
        } else if (e.defender === this.player) {
          this.run.killedBy = `${ARCHETYPES[this.enemyKind.get(e.attacker) ?? 'brawler']?.name ?? 'them'}${e.weapon ? ` · ${e.weapon.name}` : ''}${e.fatal ? ` · ${e.fatal === 'split' ? 'skull split' : e.fatal === 'cleft' ? 'skull cleft' : 'skull crushed'}` : e.sever === 'head' ? ' · decapitated' : ''}`;
        }
        // Markers: what that blow did, where it landed.
        const dmg = Math.max(1, Math.round(e.damage));
        this.logHit(e, dmg);
        if (byPlayer) this.marker(e.counter ? `COUNTER ${dmg}` : String(dmg), e.point, e.counter || e.damage >= 12 ? 'dmg big' : 'dmg');
        else if (e.defender === this.player) this.marker(`-${dmg}`, e.point, 'hurt');
        const big = e.attacker.scale > 1.3;
        // A heavy weapon lands like one: a longer catch on impact, a bigger jolt.
        const weight = e.weapon ? Math.min(1.4, 0.8 + 0.1 * e.weapon.mass) : 1;
        this.hitstop = Math.max(
          this.hitstop,
          Math.round(m.hitstop * GAME_TUNING.hitstopMul * (e.counter ? 1.35 : 1) * (e.ko ? 1.8 : 1) * (e.armored ? 0.5 : 1) * (big ? 1.25 : 1) * weight),
        );
        // Real blows don't freeze time: only a short catch (unless cues are on).
        if (!this.cues) this.hitstop = Math.min(this.hitstop, Math.max(2, Math.round(m.hitstop * 0.45 * weight)));
        this.hitstopVictim = e.defender;
        this.camRig.addTrauma(m.shake * (e.counter ? 1.3 : 1) * (e.ko ? 1.6 : 1) * (big ? 1.6 : 1) * weight * (this.cues ? 1 : 0.6));
        // Blood picked up by whatever did the hitting.
        const av = this.views.get(e.attacker);
        const bleeding = e.defender.wounds.length > 0 || (this.trauma.get(e.defender)?.cut ?? false);
        if (av && e.weapon) av.bloodyWeapon(e.weapon.edge === 'blade' ? 0.35 : e.zone === 'head' && bleeding ? 0.12 : 0);
        else if (av && !m.weapon && bleeding && e.zone === 'head' && (m.limb === 'handL' || m.limb === 'handR')) av.bloodyFist(m.limb === 'handL' ? 'L' : 'R', 0.08);
        if (heavy || e.counter || big) this.camRig.zoomPunch(1);
        // What it sounds like depends on what hit what.
        const w = e.weapon;
        if (w?.edge === 'blade') {
          if (w.id === 'axe') this.sfx.impact('axe', heavy);
        }
        else if (w) this.sfx.impact(IMPACT[w.id] ?? 'wood', heavy);
        else if (m.weapon) this.sfx.impact('wood', false); // caught with the haft
        else this.sfx.flesh(e.zone === 'head', m.weight);
        if (e.damage >= 9) this.sfx.grunt(e.defender.scale);
        const col = e.armored ? '#ff9a3c' : e.counter ? '#ffd36b' : '#fff0c8';
        if (this.cues) {
          this.effects.flash(e.point, heavy ? 0.42 : 0.26, e.counter ? '#ffd36b' : '#fff3d6');
          this.effects.sparks(e.point, e.dir, heavy ? 22 : 12, col, heavy ? 6.5 : 4.5);
        } else if (!e.weapon || e.weapon.edge === 'blunt') {
          // Real impacts don't spark: sweat flies off a face or body that gets hit.
          const head = e.zone === 'head';
          const wet = 0.4 + (this.sweat.get(e.defender) ?? 0) * 1.2;
          this.effects.sparks(e.point, e.dir.clone().setY(head ? 0.35 : 0.1), Math.round((head ? 10 : 5) * (heavy ? 1.6 : 1) * wet), '#dbe6ee', head ? 2.6 : 1.6, 0.016);
        }
        const rd = this.ragdolls.get(e.defender);
        rd?.applyHit(e.zone, e.point, e.dir, m, (e.armored ? 0.4 : 1) * Math.min(1.8, e.attacker.scale / e.defender.scale));
        if (e.knockdown || e.ko) {
          // Momentum: who hit whom, and with what.
          const k = Math.min(2.2, e.push);
          rd?.launch(e.dir.clone().multiplyScalar((m.knockback * 0.9 + (e.ko ? 1 : 0)) * k).add(new Vector3(0, 1.2 + (m.lift ?? 0) * 3, 0)));
          // (The thud comes when the body actually hits the floor: see bodyLanding.)
        }
        if (this.cues) this.views.get(e.defender)?.hitFlash();
        this.bleed(e.defender, e.zone, m, e.damage, e.counter, e.dir);
        if (e.weapon?.edge === 'blade') {
          this.sfx.slice(heavy);
          this.blood.spray(e.point, e.dir.clone().setY(0.25), 0.5 + (e.wound?.bleed ?? 0.3) * 1.2, 3);
        }
        this.lastHitBy.set(e.defender, e.attacker);
        if (e.tear) this.tearOff(e.defender, e.tear);
        if (e.sever) this.dismember(e.defender, e.sever, e.dir, e.point);
        else if (e.fatal) this.skullBlow(e.defender, e.fatal, e.dir, e.point);
        else if (!e.ko && (e.damage >= 16 || (e.counter && heavy) || (e.knockdown && heavy))) {
          // A huge blow: a quick punch-in, slowed down.
          const at = e.point.clone();
          this.cut({ focus: () => at, side: this.across(e.attacker.pos, e.defender.pos, 0.3), distance: 2.3 * Math.max(1, e.defender.scale * 0.8), height: 0.25, orbit: 0.3, fov: 38, duration: 0.8, slow: 0.22, priority: 1 });
        }
        if (this.cues) {
          if (byPlayer && e.combo >= 2) this.hud.showCombo(e.combo);
          if (byPlayer && e.counter) this.hud.popup('COUNTER', e.point, this.viewCamera, 'counter');
          if (byPlayer && e.armored) this.hud.popup('ARMORED', e.point, this.viewCamera, 'armor');
        }
        if (e.ko) this.onKO(e.defender);
        break;
      }
      case 'block': {
        this.hitstop = Math.max(this.hitstop, Math.round((e.guardBreak ? 8 : 3) * GAME_TUNING.hitstopMul));
        this.hitstopVictim = e.defender;
        this.camRig.addTrauma(e.guardBreak ? 0.35 : 0.1);
        this.sfx.block(e.move.weight === 'heavy');
        if (this.cues) {
          this.effects.sparks(e.point, e.dir, e.guardBreak ? 18 : 8, '#8fd0ff', 3.5, 0.03);
          this.effects.flash(e.point, 0.2, '#9fd8ff');
        } else this.effects.sparks(e.point, e.dir, e.guardBreak ? 8 : 4, '#dbe6ee', 1.5, 0.014);
        this.ragdolls.get(e.defender)?.applyBlock(e.dir, e.move);
        if (e.guardBreak) this.marker('GUARD BREAK', e.point, 'armor');
        if (e.guardBreak) this.recorder.mark('down', e.defender === this.player ? 'Your guard broken' : 'Guard broken');
        else if (e.parry && e.perfect) {
          // Timed to the last instant: a beat of slow motion, and you're straight in.
          this.marker('PERFECT PARRY', e.point, 'parry big');
          this.recorder.mark('parry', 'Perfect parry');
          this.slowmo = Math.max(this.slowmo, 0.35);
          this.camRig.zoomPunch(0.6);
          this.effects.ring(this.player.pos, 1.1, '#ffd36b', 0.5, () => this.player.pos);
          this.sfx.counterReady();
          this.run.perfect++;
        } else if (e.parry) this.marker(e.defender === this.player ? 'PARRY!' : 'PARRIED', e.point, e.defender === this.player ? 'parry' : 'hurt');
        else if (e.defender === this.player) this.marker('BLOCK', e.point, 'block');
        else this.marker('BLOCKED', e.point, 'block');
        break;
      }
      case 'dodge': {
        this.sfx.dodge();
        if (e.defender === this.player && e.perfect) {
          // Timed to the strike: a beat of slow motion, and the counter's yours.
          this.marker('PERFECT DODGE', e.point, 'parry big');
          this.recorder.mark('parry', 'Perfect dodge');
          this.slowmo = Math.max(this.slowmo, 0.35);
          this.camRig.zoomPunch(0.6);
          this.effects.ring(this.player.pos, 1.1, '#ffd36b', 0.5, () => this.player.pos);
          this.run.perfect++;
        } else if (e.defender === this.player) this.marker(e.kind === 'airborne' ? 'EVADED' : 'DODGE', e.point, 'parry');
        else this.marker('MISS', e.point, 'miss');
        if (e.defender === this.player && e.kind !== 'airborne') {
          this.sfx.counterReady();
          if (this.cues) this.effects.ring(this.player.pos, 0.9, '#ffd36b', 0.45, () => this.player.pos);
        }
        break;
      }
      case 'defend':
        if (e.kind === 'slide') this.effects.dust(e.f.pos, 10, 0.4);
        break;
      case 'perk': {
        const label = e.perk === 'secondWind' ? 'SECOND WIND' : e.perk === 'lastStand' ? 'LAST STAND' : '';
        if (label) {
          this.marker(label, e.point, e.f === this.player ? 'parry big' : 'hurt');
          if (e.f === this.player) {
            this.sfx.counterReady();
            this.slowmo = Math.max(this.slowmo, 0.4);
          }
        }
        break;
      }
      case 'swing':
        this.sfx.whoosh(e.move.weight);
        this.sfx.exhale(e.move.weight !== 'light', e.f.scale);
        if (e.move.id === 'slideKick' || e.move.id === 'flyingKick') this.effects.dust(e.f.pos, 8, 0.4);
        break;
      case 'getup':
        this.effects.dust(e.f.pos, 10, 0.5 * e.f.scale);
        break;
      case 'throw': {
        const w = e.projectile.weapon;
        this.sfx.whoosh(w.mass > 1.5 ? 'heavy' : w.mass > 0.5 ? 'medium' : 'light');
        this.sfx.exhale(true, e.f.scale);
        break;
      }
      case 'thud': {
        const w = e.projectile.weapon;
        const hard = Math.min(1, e.speed / 12);
        this.sfx.landing(w.mass, !WOODEN.has(w.id), hard);
        this.effects.dust(e.point, Math.round(2 + 4 * hard), 0.06 + 0.04 * w.mass);
        break;
      }
      case 'pickup':
        this.sfx.clank(true);
        if (this.cues) {
          this.effects.ring(e.drop.pos, 0.6, '#ffd36b', 0.35);
          if (e.f === this.player) this.hud.popup(e.drop.weapon.name.toUpperCase(), new Vector3(e.f.pos.x, 2.1, e.f.pos.z), this.viewCamera, 'counter');
        }
        this.syncDropViews();
        break;
      case 'drop':
        // (Something let go of mid-air sounds when it lands.)
        if (!e.drop.from) this.sfx.clank(false);
        this.syncDropViews();
        break;
      case 'bump':
        this.sfx.bump();
        break;
      case 'clang': {
        // A strike that ran into the scenery: a pillar, a crate, a car.
        const w = e.f.weapon;
        const away = new Vector3(e.f.pos.x - e.point.x, 0.4, e.f.pos.z - e.point.z).normalize();
        if (w) {
          this.sfx.impact(e.metal ? 'metal' : (IMPACT[w.id] ?? 'wood'), true);
          // Steel on stone or iron throws a few sparks; anything else just knocks off grit.
          const steel = w.edge === 'blade' || IMPACT[w.id] === 'metal';
          if (e.metal && steel) this.effects.sparks(e.point, away, 10, '#ffd27a', 3.2, 0.012);
          else this.effects.sparks(e.point, away, 6, e.metal ? '#b9b2a6' : '#8a6a48', 1.4, 0.02);
        } else {
          this.sfx.bump();
          this.effects.sparks(e.point, away, 4, '#b9b2a6', 1, 0.015);
        }
        if (e.f === this.player) this.camRig.addTrauma(0.12);
        break;
      }
      case 'bleedout':
        if (this.cues) this.hud.popup('BLED OUT', new Vector3(e.f.pos.x, 1.6, e.f.pos.z), this.viewCamera, 'armor');
        this.onKO(e.f);
        break;
      default:
        break;
    }
  }

  private breathT = 0;
  private breathOut = false;

  /** You can hear yourself sucking air when you're gassed. */
  private panting(dt: number) {
    const p = this.player;
    const tired = Math.max(0, Math.min(1, (0.4 - p.stamina) / 0.35));
    if (!p.alive || tired <= 0) return;
    this.breathT -= dt;
    if (this.breathT > 0) return;
    this.breathOut = !this.breathOut;
    this.sfx.pant(this.breathOut, 0.5 + tired);
    this.breathT = this.breathOut ? 0.42 - tired * 0.12 : 0.3 - tired * 0.08;
  }

  /** A combat marker over the action (always on, unlike the optional combat cues). */
  private marker(text: string, at: Vector3, cls: string) {
    if (this.cine.active) return;
    this.hud.popup(text, at.clone().setY(at.y + 0.25), this.viewCamera, cls);
  }

  /** The attack buttons, bottom left: what each throws right now and when it's ready. */
  private updateMovePanel(dt: number) {
    const p = this.player;
    const b = this.input.bindings;
    const total = p.state === 'attack' && p.move ? p.attackEnd || moveLength(p.move) : 1;
    const busyLeft = p.state === 'attack' ? 1 - p.stateFrame / Math.max(1, total) : p.free ? 0 : 1;
    const cue = this.tactics(dt);
    const incoming = p.alive ? this.sim.threatFor(p) : null;
    const BTN = ['lpunch', 'rpunch', 'lkick', 'rkick'] as const;
    const ALT: Partial<Record<(typeof BTN)[number], string>> = { lpunch: 'LMB', rpunch: 'RMB' };
    const slots: Parameters<Hud['moves']>[0] = BTN.map((btn) => {
      const pick = buttonMove(p, btn);
      const limb = btn === 'lpunch' ? 'foreArmL' : btn === 'rpunch' ? 'foreArmR' : btn === 'lkick' ? 'shinL' : 'shinR';
      const state: 'ready' | 'busy' | 'chain' | 'counter' | 'locked' = !p.alive || p.isSevered(limb) || !pick.move
        ? 'locked'
        : pick.ready
          ? pick.counter
            ? 'counter'
            : pick.chain
              ? 'chain'
              : 'ready'
          : 'busy';
      // With a strike about to land, Q and E meet it instead: a parry (or a slide back
      // out of a big swing).
      const meets = (btn === 'lpunch' || btn === 'rpunch') && !!incoming && !p.counter && state !== 'locked';
      const name = meets ? (CombatSim.parryable(p, incoming!) ? 'Parry' : 'Slide out') : pick.move?.name ?? '—';
      return { key: keyLabel(b[btn]), name, state: meets ? 'counter' : state, left: state === 'busy' && !meets ? busyLeft : 0, alt: ALT[btn], hint: cue?.hint === btn || (cue?.hint === 'parry' && (btn === 'lpunch' || btn === 'rpunch')) };
    });
    this.hud.moves(slots);
    const cueKey = cue?.hint === 'parry' ? `${keyLabel(b.lpunch)}/${keyLabel(b.rpunch)}` : cue?.hint ? keyLabel(b[cue.hint]) : '';
    this.hud.cue(cue && this.settings.prefs.tips && !this.cine.active ? { text: cue.text, kind: cue.kind, key: cueKey } : null);
    // Something on its way in at you.
    const threat = this.enemies.find((e) => e.alive && e.state === 'attack' && e.move && !e.move.noHit && e.target === p && e.stateFrame < e.move.startup);
    this.hud.incoming(threat ? new Vector3(threat.pos.x, threat.rig.head.pos.y + 0.45 * threat.scale, threat.pos.z) : null, this.cine.active ? null : this.viewCamera, !!threat?.move?.armor);
  }

  private lastCue: { text: string; kind: 'danger' | 'open' | 'counter' | 'info'; hint: Button | 'parry' | null; rank: number } | null = null;
  private cueHold = 0;

  /**
   * Reading the fight for you: what's the right thing to do this moment? A big swing
   * coming (dodge it), a counter window open (take it), an opponent off balance or
   * recovering from a miss (punish), one covering up high (go low), you gassed or
   * predictable. Held briefly so it doesn't flicker; a more urgent one cuts in.
   */
  private tactics(dt: number) {
    const p = this.player;
    const t = p.target;
    let next: typeof this.lastCue = null;
    if (this.phase === 'play' && p.alive && t && t.alive) {
      const d = p.distanceTo(t);
      const pick = (btn: Button) => buttonMove(p, btn);
      const reach = (m: MoveDef | null | undefined) => (m ? (m.reach + p.stats.reach) * p.scale + 0.35 : 0);
      const tm = t.move;
      // (Anything but a flicked jab is worth calling.)
      const worth = !!tm && (tm.weight !== 'light' || !!tm.armor || !!tm.weapon || !!tm.air || t.scale > 1.3);
      if (t.state === 'attack' && tm && !tm.noHit && !t.hitThisAttack && !p.counter && t.framesToActive >= 1 && t.framesToActive <= 26 && worth && d < (tm.reach + t.stats.reach) * t.scale + 0.8) {
        // Wait for it… then now: met in the last instant, it's a perfect parry (or dodge).
        const parry = CombatSim.parryable(p, t);
        const window = parry ? DEFENSES.block.startup + PARRY_WINDOW : PERFECT_DODGE;
        next = t.framesToActive <= window
          ? { text: parry ? 'Parry now!' : 'Slide out now!', kind: 'danger', hint: 'parry', rank: 5 }
          : { text: `${tm.name} coming — wait for it`, kind: 'danger', hint: 'parry', rank: 5 };
      } else if (p.counter) {
        const btn = (['rpunch', 'lpunch', 'rkick', 'lkick'] as const).find((x) => pick(x).counter && pick(x).ready) ?? null;
        if (btn) next = { text: p.perfectCounter ? 'Perfect! Counter now' : 'Counter now', kind: 'counter', hint: btn, rank: 4 };
      } else if (t.state === 'guardbreak') {
        next = { text: 'Guard broken — big shot', kind: 'open', hint: pick('rpunch').ready ? 'rpunch' : 'lpunch', rank: 3 };
      } else if (t.state === 'attack' && tm && !t.hitThisAttack && t.stateFrame >= tm.startup + tm.active && d < reach(pick('lpunch').move) + 0.3) {
        next = { text: 'They missed — punish', kind: 'open', hint: 'lpunch', rank: 3 };
      } else if (t.state === 'hitstun' && t.stateFrame < 10 && d < reach(pick('lpunch').move) + 0.2) {
        const chain = (['lpunch', 'rpunch', 'lkick', 'rkick'] as const).find((x) => pick(x).chain && pick(x).ready);
        next = { text: 'Rocked — keep going', kind: 'open', hint: chain ?? 'lpunch', rank: 2 };
      } else if ((t.state === 'blockstun' || (t.state === 'defend' && t.defense?.def.kind === 'block')) && d < 2.2 * p.scale) {
        const low = (['rkick', 'lkick'] as const).find((x) => pick(x).move?.height === 'low' && pick(x).ready);
        next = { text: low ? 'Guard up — go low' : 'Guard up — go round it', kind: 'info', hint: low ?? null, rank: 1 };
      } else if (t.state === 'knockdown' || t.state === 'getup') {
        next = { text: 'They’re down — get set', kind: 'info', hint: null, rank: 1 };
      } else if (p.stamina < 0.22) {
        next = { text: 'Gassed — back off and breathe', kind: 'info', hint: null, rank: 1 };
      } else if (p.repeatCount >= 3) {
        next = { text: 'They’ve read you — mix it up', kind: 'info', hint: null, rank: 1 };
      }
    }
    // (A warning ends the moment it no longer applies — you dodged, or it's over.)
    const stale = this.lastCue?.kind === 'danger' && next?.kind !== 'danger';
    if (stale && !next) {
      this.lastCue = null;
      this.cueHold = 0;
    }
    if (next && (!this.lastCue || stale || next.rank >= this.lastCue.rank || this.cueHold <= 0)) {
      if (!this.lastCue || next.text !== this.lastCue.text) this.cueHold = 0.6;
      this.lastCue = next;
    } else if (!next && this.cueHold <= 0) this.lastCue = null;
    this.cueHold -= dt;
    return this.lastCue;
  }

  /** Coming down from a jump or a flip: both feet hit the floor at once, with weight. */
  private landings() {
    const surface = FLOOR[this.theme.id];
    for (const f of this.sim.fighters) {
      const up = f.isAirborne();
      if (up) this.airborne.add(f);
      else if (this.airborne.delete(f) && f.state === 'attack') {
        this.sfx.footstep(surface, 1, f.scale * 1.15);
        this.sfx.footstep(surface, 0.9, f.scale * 1.15);
        this.effects.dust(f.pos, 6, 0.3 * f.scale);
        if (f.scale > 1.3) this.camRig.addTrauma(0.08 * f.scale);
      }
    }
  }

  /** Feet that landed this step, on whatever the floor is made of. */
  private footsteps() {
    const surface = FLOOR[this.theme.id];
    for (const f of this.sim.fighters) {
      const landed = f.footwork.landed;
      if (!landed.length) continue;
      const speed = Math.hypot(f.walkVel.x, f.walkVel.z) / f.scale;
      for (let i = 0; i < landed.length; i++) {
        this.sfx.footstep(surface, Math.min(1, speed / 3.8), f.scale);
        // A giant's footfalls are felt as much as heard, the closer the more.
        if (f.scale > 1.3 && f !== this.player) {
          const near = Math.max(0, 1 - this.player.distanceTo(f) / 6);
          if (near > 0) this.camRig.addTrauma(0.05 * (f.scale - 1) * near * Math.min(1, 0.5 + speed / 4));
        }
        // Sand kicks up under a moving foot.
        if (surface === 'sand' && speed > 1) this.effects.dust(f.footwork.foot(landed[i]).pos, 2 + Math.round(speed), 0.08 * f.scale);
      }
      landed.length = 0;
    }
  }

  private readonly falls = new Map<Fighter, { vy: number; quiet: number }>();

  /**
   * A body going down can fall against someone still standing — but it can't rest on
   * them: whoever's upright isn't a post, so it slides off them to the floor.
   */
  private slideOff(f: Fighter, rd: Ragdoll) {
    if (f.state !== 'knockdown' && f.state !== 'ko') return;
    for (const s of this.sim.fighters) {
      if (s === f || !s.alive || s.state === 'knockdown' || s.state === 'ko') continue;
      for (const b of TORSO) {
        const body = rd.bodies[b];
        const v = body.linvel();
        // Still flying from the blow: let the launch play out.
        if (v.y > 0.3) continue;
        const t = body.translation();
        if (t.y < 0.35 * f.scale) continue;
        const dx = t.x - s.pos.x;
        const dz = t.z - s.pos.z;
        const d = Math.hypot(dx, dz);
        const reach = 0.42 * s.scale + 0.2 * f.scale;
        if (d > reach) continue;
        const k = (reach - d) * 6;
        const nx = d > 1e-3 ? dx / d : 1;
        const nz = d > 1e-3 ? dz / d : 0;
        body.setLinvel({ x: v.x + nx * k * DT * 30, y: Math.min(v.y, 0), z: v.z + nz * k * DT * 30 }, true);
      }
    }
  }

  /**
   * A body hitting the floor: heard (and, for something big, felt) at the moment it
   * lands, not when the blow was struck — a heavy thud, dust, the camera jolting when a
   * giant goes down.
   */
  private bodyLanding(f: Fighter, rd: Ragdoll) {
    let s = this.falls.get(f);
    if (!s) this.falls.set(f, (s = { vy: 0, quiet: 0 }));
    s.quiet = Math.max(0, s.quiet - 1);
    const down = f.state === 'knockdown' || f.state === 'ko';
    const v = rd.bodies.pelvis.linvel();
    const c = rd.bodies.chest.linvel();
    const vy = Math.min(v.y, c.y);
    if (down && s.quiet === 0 && s.vy < -1.4 && vy > s.vy * 0.35) {
      const p = rd.pelvisPos();
      if (p.y < 0.45 * f.scale) {
        const mass = f.scale * f.scale * f.scale;
        const hard = Math.min(1, -s.vy / 5);
        this.sfx.bodyFall(mass, hard);
        this.effects.dust(new Vector3(p.x, 0, p.z), Math.round(6 + 10 * hard * Math.min(3, mass)), 0.25 * f.scale);
        // Big things shake the floor you're standing on.
        if (mass > 1.5) this.camRig.addTrauma(Math.min(0.6, 0.08 * mass * hard));
        s.quiet = 20;
      }
    }
    s.vy = vy;
  }

  /** A limb comes off: the ragdoll lets it go, blood everywhere. */
  private dismember(f: Fighter, bone: import('../body/skeleton').BoneName, dir: Vector3, point: Vector3) {
    const rd = this.ragdolls.get(f);
    const fling = dir.clone().multiplyScalar(2.6).add(new Vector3(0, bone === 'head' ? 3.2 : 2.2, 0));
    rd?.sever(bone, limbBones(bone), fling);
    this.sfx.sever();
    this.camRig.addTrauma(0.45);
    this.camRig.zoomPunch(1.2);
    this.slowmo = Math.max(this.slowmo, 0.6);
    for (let i = 0; i < 4; i++) this.blood.spray(point, dir.clone().setY(0.6 + i * 0.2), 1, 3.4);
    // Close and almost frozen, over the shoulder of whoever did it.
    const by = this.lastHitBy.get(f) ?? this.player;
    const at = point.clone();
    // A head that comes off is followed through the air (framed a little wider, so the
    // body buckling below stays in the shot); a limb, the wound.
    const head = bone === 'head' && rd ? rd.bodies.head : null;
    const track = new Vector3();
    this.cut({
      focus: head
        ? () => {
            const t = head.translation();
            return track.set(t.x, t.y, t.z).lerp(at, 0.35);
          }
        : () => at,
      side: this.across(by.pos, f.pos, 0.45),
      distance: (head ? 2.5 : 1.7) * Math.max(1, f.scale * 0.8),
      height: head ? 0.05 : 0.2,
      orbit: 0.45,
      dolly: -0.25,
      fov: 36,
      // Taking the head is the finishing blow: this is the finisher shot.
      duration: head ? 2.3 : 1.5,
      slow: 0.1,
      priority: head ? 4 : 3,
    });
    const label = bone === 'head' ? 'DECAPITATED' : bone.startsWith('thigh') || bone.startsWith('shin') ? 'LEG OFF' : 'ARM OFF';
    if (this.cues) this.hud.popup(label, point, this.viewCamera, 'armor');
  }

  /**
   * Straight down onto the skull: split open by a big edge, cleft by a shorter one, or
   * caved in by something heavy.
   * Nobody gets up — the kill is held on, close, the way a decapitation is.
   */
  private skullBlow(f: Fighter, kind: Fatal, dir: Vector3, point: Vector3) {
    const view = this.views.get(f);
    if (kind === 'split') view?.splitHead();
    else if (kind === 'cleft') view?.cleftHead();
    else view?.crushHead();
    this.sfx.sever();
    this.camRig.addTrauma(0.5);
    this.camRig.zoomPunch(1.2);
    this.slowmo = Math.max(this.slowmo, 0.6);
    const top = view ? view.facePoint('brow') : point.clone();
    for (let i = 0; i < 5; i++) this.blood.spray(top, dir.clone().setY(1 + i * 0.25), 1, kind === 'split' ? 2.6 : 3.2);
    const by = this.lastHitBy.get(f) ?? this.player;
    const at = point.clone();
    this.cut({ focus: () => at, side: this.across(by.pos, f.pos, 0.45), distance: 1.9 * Math.max(1, f.scale * 0.8), height: 0.25, orbit: 0.4, dolly: -0.2, fov: 36, duration: 2.1, slow: 0.1, priority: 4.5 });
    if (this.cues) this.hud.popup(kind === 'split' ? 'SKULL SPLIT' : kind === 'cleft' ? 'SKULL CLEFT' : 'SKULL CRUSHED', point, this.viewCamera, 'armor');
  }

  /** A piece torn off: gone from the body, flying, and landing somewhere on the floor. */
  private tearOff(f: Fighter, t: Tear) {
    const view = this.views.get(f);
    view?.tear(t.piece, t.bone, t.local, t.size / f.scale);
    if (this.blood.enabled) {
      this.gibs.spawn(t.point, t.vel, t.size, view?.palette.skin ?? '#d9a07a', t.piece);
      this.blood.spray(t.point, t.vel.clone(), 0.8, 2.2);
    }
    const label = t.piece === 'earL' || t.piece === 'earR' ? 'EAR OFF' : t.piece === 'scalp' ? 'SCALPED' : null;
    if (label) this.marker(label, t.point, f === this.player ? 'hurt' : 'big');
  }

  /** Accumulate trauma and spill blood where it makes sense (mouth, nose, brow). */
  private bleed(f: Fighter, zone: HurtZone, m: MoveDef, damage: number, counter: boolean, dir: Vector3) {
    let t = this.trauma.get(f);
    if (!t) this.trauma.set(f, (t = new Trauma()));
    const view = this.views.get(f);
    for (const b of t.onHit(zone, m, damage, counter)) {
      if (!view) break;
      const at = view.facePoint(b.source);
      // Along the blow and up; a cough spills forward (toward the attacker) and down.
      const d = b.style === 'hit' ? dir.clone().setY(0.35) : dir.clone().negate().setY(-0.4);
      this.blood.spray(at, d, b.amount * f.scale, b.style === 'hit' ? 2.8 : 1.4);
    }
    view?.setTrauma(t.bruise, t.cut);
  }

  private onKO(f: Fighter) {
    this.sfx.ko();
    this.camRig.addTrauma(0.5 * f.scale);
    if (f === this.player) {
      this.slowmo = 1.5;
      this.phase = 'down';
      // Your fall, seen from above; the colour drains out.
      const by = this.lastHitBy.get(f) ?? this.enemy ?? f;
      this.hud.mood('death');
      this.cut({ focus: this.pelvisOf(f), side: this.across(by.pos, f.pos, -0.2), distance: 3.0, height: 1.7, orbit: 0.16, dolly: -0.2, fov: 40, duration: 3.2, slow: 0.22, priority: 5 });
      this.clearIn = this.holdIn = -1;
      if (this.mode === 'gauntlet') {
        // The run is over — but what it earned is yours to spend on the next one.
        const prevBest = this.save.bestRound;
        const parts = deathRewardParts(this.round, prevBest);
        const pay = parts.base + parts.bonus;
        const best = Math.max(prevBest, this.round - 1);
        this.save.bestRound = best;
        this.save.coins += pay;
        this.lastPay = pay;
        writeSave(this.save);
        const r = this.run;
        this.runSummary = {
          round: this.round, best, newBest: this.round - 1 > prevBest, killedBy: r.killedBy,
          kos: r.kos, hits: r.hits, damage: r.damage, bestCombo: r.bestCombo, perfect: r.perfect, brutal: r.brutal,
          seconds: (performance.now() - r.started) / 1000, pay: parts, coins: this.save.coins,
        };
        this.banner('K.O.', `round ${this.round}`, 'down', 2.6);
      } else {
        this.banner('DOWN', 'get up', 'down', 3.2);
      }
      this.downIn = 3.4;
      return;
    }
    this.koAt.set(f, this.sim.frame);
    this.run.kos++;
    // The finishing blow: low and from the side, following them down.
    // (A decapitation already has its own shot, following the head.)
    if (this.enemies.every((e) => !e.alive) && this.player.alive && !f.isSevered('head')) {
      const by = this.lastHitBy.get(f) ?? this.player;
      this.cut({ focus: this.pelvisOf(f), side: this.across(by.pos, f.pos, 0.1), distance: 3.8 * Math.max(1, f.scale * 0.75), height: 0.55, orbit: 0.3, fov: 38, duration: 2.2, slow: 0.18, priority: 4 });
    }
    if (this.mode === 'training') {
      this.slowmo = 1.5;
      this.kos++;
      this.banner('K.O.', `round ${this.wave} clear`, '', 3.2);
      this.respawnIn = 3.2;
      return;
    }
    // Coins burst out; slow-mo only for the last enemy of a round.
    const kind = this.enemyKind.get(f) ?? 'brawler';
    const at = this.ragdolls.get(f)?.pelvisPos() ?? f.pos.clone();
    this.coins.burst(at, Math.round(coinDrop(kind, this.sim.rng, this.round) * this.coinMul));
    if (this.enemies.every((e) => !e.alive)) this.slowmo = 1.2;
  }

  // ---------------------------------------------------------------------------

  private render(realDt: number, simDt: number, alpha: number) {
    this.simClock += simDt;
    for (const [f, view] of this.views) {
      const rd = this.ragdolls.get(f);
      if (rd) view.syncFromRagdoll(rd, alpha);
      else view.syncFromRig(f);
      view.updateCues(realDt, f, this.cues);
    }

    // Telegraph ring when an enemy starts winding up.
    for (const e of this.enemies) {
      if (e.state === 'attack' && e.move && e.attackSerial !== this.telegraphed.get(e)) {
        this.telegraphed.set(e, e.attackSerial);
        if (this.cues) this.effects.ring(e.pos, 0.85 * e.scale, e.move.armor ? '#ff7a20' : '#ff3828', (e.move.startup / 60) * 1.1, () => e.pos);
      }
    }

    this.effects.update(simDt, realDt);
    // (In a freeze-frame the blood still creeps outward — barely — so the spray is a fan of
    // drops in the air, not one clump.)
    this.blood.update(Math.max(simDt, realDt * 0.1));
    this.gibs.update(simDt, (at, speed) => this.blood.spray(at, new Vector3(0, 1, 0), Math.min(0.4, speed * 0.08), 0.6));
    if (simDt > 0) {
      for (const [f, t] of this.trauma) {
        if (!t.drip(simDt, this.fxRng)) continue;
        const view = this.views.get(f);
        if (view) this.blood.drip(view.facePoint(t.cut && Math.random() < 0.4 ? 'brow' : 'mouth'));
      }
    }
    const got = this.coins.update(simDt, this.player.pos);
    if (got > 0) {
      this.save.coins += got;
      this.hud.setCoins(this.save.coins);
      this.sfx.coin();
      writeSave(this.save);
    }
    this.themeView?.update(this.time);
    this.updateWeaponsAndWounds(simDt);
    if (simDt > 0) this.panting(realDt);

    // Camera: framing you and whoever you're fighting.
    const p = this.player;
    const t = p.target && p.target.alive && p.distanceTo(p.target) < 9 ? p.target : null;
    const spread = t ? p.distanceTo(t) + (t.scale - 1) * 2.2 : 0;
    this.camRig.zoom = this.slowmo > 0 ? 1.12 : 1;
    const walk = this.sim.walkable;
    this.camRig.inside = (x, z) => walk.isWalkable(x, z);
    this.camRig.update(realDt, p, t);
    const cutFocus = p.pos.clone();
    if (t) cutFocus.lerp(t.pos, 0.5);
    cutFocus.y = 1;
    updateCutout(this.viewCamera, cutFocus, 0.3 + Math.min(0.25, spread * 0.06), this.renderer.domElement.width / this.renderer.domElement.height);

    const head = new Vector3(p.pos.x, 2.25, p.pos.z);
    const near = p.alive ? this.dropInReach() : null;
    // (A weapon falls at the same speed as everything else, slowed in a slow-motion.)
    for (const [id, v] of this.dropViews) v.update(this.simClock, near?.id === id);
    this.syncProjectiles();
    if (near && this.phase === 'play') {
      const k = keyLabel(this.input.bindings.pickup);
      this.hud.prompt(`<b>${k}</b> ${p.weapon ? 'swap for' : 'grab'} ${near.weapon.name}`, head, this.camRig.camera);
    } else {
      this.hud.prompt('');
    }

    this.updateDebug();
    const shown = t ?? (this.phase === 'play' ? this.enemies.find((e) => e.alive) ?? null : null);
    this.hud.update(realDt, p, shown, this.label());
    this.updateMovePanel(realDt);
    this.renderer.render(this.scene, this.viewCamera);
    this.recorder.afterRender();
    this.hud.logButton.classList.toggle('rec', this.recorder.recording && this.recorder.enabled && this.recorder.canRecord);
  }

  /** The moments that go on the battle log's timeline. */
  private logHit(e: Extract<CombatEvent, { type: 'hit' }>, dmg: number) {
    const them = (f: Fighter) => (f === this.player ? 'You' : ARCHETYPES[this.enemyKind.get(f) ?? 'brawler']?.name ?? 'Them');
    const what = e.weapon ? `${e.weapon.name} ${e.move.name.toLowerCase()}` : e.move.name;
    if (e.fatal) this.recorder.mark('gore', `${them(e.attacker)}: ${e.fatal === 'split' ? 'skull split' : e.fatal === 'cleft' ? 'skull cleft' : 'skull crushed'}`);
    else if (e.sever) this.recorder.mark('gore', `${them(e.attacker)}: ${e.sever === 'head' ? 'decapitation' : 'limb off'}`);
    if (e.ko) this.recorder.mark(e.defender === this.player ? 'death' : 'ko', e.defender === this.player ? `Knocked out by ${them(e.attacker)}'s ${what.toLowerCase()}` : `KO — ${what}`);
    else if (e.knockdown) this.recorder.mark('down', `${them(e.defender)} knocked down (${what.toLowerCase()})`);
    else if (e.attacker === this.player && (dmg >= 12 || e.counter)) this.recorder.mark('hit', `${e.counter ? 'Counter ' : ''}${what} · ${dmg}`);
    else if (e.defender === this.player && dmg >= 12) this.recorder.mark('hurt', `Hit by ${what.toLowerCase()} · -${dmg}`);
  }

  /** Opens the battle log (pausing the fight) on the latest battle. */
  openLog() {
    if (this.battleLog.isOpen) return;
    this.setMenuPause(true);
    this.battleLog.open();
  }

  /** Weapons in hand, new cuts on bodies, and blood dripping from every open wound. */
  private updateWeaponsAndWounds(simDt: number) {
    for (const [f, view] of this.views) {
      view.setWeapon(f.isSevered('foreArmR') ? null : f.weapon);
      if (f.weapon) {
        view.updateWeapon(f, f.weapon.length, simDt);
        // A bloodied blade drips for a while.
        if (simDt > 0 && view.weaponBlood > 0.08 && this.blood.enabled) {
          view.weaponBlood *= 0.999;
          if (Math.random() < view.weaponBlood * simDt * 5) {
            const tip = view.weaponTip(f.weapon.length, f.scale);
            if (tip) this.blood.drip(tip);
          }
        }
      }
      // Sweat builds with time and exertion.
      if (simDt > 0) {
        const s = Math.min(1, (this.sweat.get(f) ?? 0) + simDt * (0.006 + 0.035 * (1 - f.stamina)));
        this.sweat.set(f, s);
        view.setSweat(s);
      }
      for (const w of f.wounds) {
        if (!this.shownWounds.has(w)) {
          this.shownWounds.add(w);
          view.addWound(w);
        }
        if (simDt <= 0 || w.bleed <= 0.02 || !this.blood.enabled) continue;
        if (w.stump && w.bleed > 0.45 && Math.random() < 0.6) {
          // Arterial spurts from a fresh stump.
          const at = view.woundPoint(w);
          const out = at.clone().sub(view.bones.chest.getWorldPosition(new Vector3())).setY(0).normalize().setY(w.stump === 'head' ? 1.4 : 0.5);
          this.blood.spray(at, out, 0.18 * w.bleed, 1.6 + Math.random());
        } else if (Math.random() < w.bleed * simDt * 6) {
          this.blood.drip(view.woundPoint(w));
        }
      }
    }
  }

  private label(): string {
    if (this.mode === 'training') return `TRAINING · ROUND ${this.wave}${this.kos ? `  ·  ${this.kos} KO` : ''}`;
    const best = this.save.bestRound > 0 ? `  ·  BEST ${this.save.bestRound}` : '';
    return `ROUND ${this.round}  ·  ${this.theme.name.toUpperCase()}${best}`;
  }

  private updateDebug() {
    this.debugGroup.visible = GAME_TUNING.showHitboxes;
    if (!GAME_TUNING.showHitboxes) return;
    let i = 0;
    const use = (mat: MeshBasicMaterial, at: Vector3, r: number) => {
      let m = this.debugPool[i];
      if (!m) {
        m = new Mesh(this.sphereGeo, mat);
        this.debugPool.push(m);
        this.debugGroup.add(m);
      }
      m.material = mat;
      m.visible = true;
      m.position.copy(at);
      m.scale.setScalar(r);
      i++;
    };
    for (const f of this.sim.fighters) {
      for (const h of ['high', 'mid', 'low'] as const) for (const s of hurtSpheres(f, h)) use(this.debugMats.hurt, s.center, s.r);
      for (const b of BONES) use(this.debugMats.target, f.rig[b].pos, 0.018 * f.scale);
      if (f.move && f.inActiveFrames()) use(this.debugMats.strike, strikePoint(f, f.move, new Vector3()), (f.move.radius + f.stats.reach) * f.scale);
    }
    for (; i < this.debugPool.length; i++) this.debugPool[i].visible = false;
  }
}
