import { describe, expect, it } from 'vitest';

// Rule 6 in the client (docs/SPEC.md, Commands; docs/M1-DESIGN.md §10.1, §10.11): player input reaches the sim only as
// tick-tagged commands, which input/verbInput.ts produces and game/loop.ts pushes onto world.commands; no client code
// writes a fighter's state or calls a world mutator; and game.ts reaches the other client modules only through the
// interfaces of game/ports.ts (RF-9). The client can't be run headless, so this guards the rules by reading its source.
const SOURCES = import.meta.glob<string>('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

/** The source with comments blanked (line numbers kept). */
function code(text: string): string[] {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks.split('\n').map((line) => line.replace(/\/\/.*$/, ''));
}

/** Every `file:line: text` whose code matches one of `patterns`, outside the files in `allowed`. */
function offences(patterns: RegExp[], allowed: string[] = []): string[] {
  const out: string[] = [];
  for (const [file, text] of Object.entries(SOURCES)) {
    if (allowed.includes(file)) continue;
    code(text).forEach((line, i) => {
      if (patterns.some((p) => p.test(line))) out.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

const LOOP = '../src/game/loop.ts';
const VERB_INPUT = '../src/input/verbInput.ts';

describe('client input routing', () => {
  it('reads the client sources', () => {
    const files = Object.keys(SOURCES);
    for (const f of ['../src/game/game.ts', LOOP, '../src/game/ports.ts', VERB_INPUT, '../src/main.ts']) expect(files).toContain(f);
    expect(files.length).toBeGreaterThan(20);
    // The training ring is gone (D-50, SPEC:863).
    expect(files).not.toContain('../src/arena/themeView.ts');
  });

  it('never writes moveInput, press() or pickupRequest on a fighter', () => {
    expect(offences([/\.moveInput\b/, /\.press\(/, /\.pickupRequest\s*=(?!=)/])).toEqual([]);
  });

  it('writes no other fighter state: verbRequest, pos, footwork landings, the downed flag, the walkable (§10.11)', () => {
    expect(
      offences([
        /\.verbRequest\s*=(?!=)/,
        /\.pos\.set\(/,
        /\.pos\.copy\(/,
        /\.landed\.length\s*=(?!=)/,
        /\.landed\.(splice|pop|shift)\(/,
        /\.(externalKnockdown|physicsOwnsDowned)\s*=(?!=)/,
        /\.walkable\s*=(?!=)/,
      ]),
    ).toEqual([]);
  });

  it("assigns no fighter field, moves no fighter's position, and edits no fighter's wounds (rule 6)", () => {
    // A fighter as client code names it (DS game.ts's names included).
    const F = String.raw`\b(?:f|fighter|player|victim|defender|attacker|killer|target|e\.f|e\.victim|e\.defender|e\.attacker|e\.killer|this\.player|world\.player|w\.player)`;
    const FIELDS = String.raw`(?:weapon|hp|yaw|state|stateFrame|stamina|guard|poise|stats|minHp|counter|buffer|target|name|team|scale|massKg|inventory|load|drive|posture|work|moveFlags|jumpRequest|idlePaused|ruler|playerId|lastKnock|armour|toughnessJ|species|wounds|severed|limbDamage)`;
    const VECTOR_WRITE = String.raw`(?:[xyz]\s*[-+*/]?=(?!=)|(?:set|copy|add|sub|addScaledVector|lerp|multiplyScalar|setX|setY|setZ|setScalar|applyQuaternion|normalize)\()`;
    expect(
      offences([
        new RegExp(String.raw`${F}\.${FIELDS}\s*[-+*/]?=(?!=)`),
        new RegExp(String.raw`${F}\.(?:pos|vel|walkVel|moveInput|rig)\.${VECTOR_WRITE}`),
        new RegExp(String.raw`Object\.assign\(\s*${F}\b`),
        /\.wounds\.(push|splice|pop|shift)\(|\.wounds\.length\s*=(?!=)|\.severed\.(add|delete|clear)\(/,
      ]),
    ).toEqual([]);
    // Any `.pos.x = …` outside the particle pools (whose drops and sparks have their own `pos`).
    expect(offences([/\.pos\.[xyz]\s*[-+*/]?=(?!=)/], ['../src/render/particles.ts', '../src/render/blood.ts', '../src/render/gibs.ts'])).toEqual([]);
  });

  it("consumes none of the sim's random streams and never reaches into its Rapier world (rule 7)", () => {
    expect(offences([/\.(rng|rngs)\b/, /\bworld\.physics\b/, /\.physics\.rapier\b/])).toEqual([]);
  });

  it('changes sim tuning only through the setTuning dev command (applied at its tick, RR-17)', () => {
    expect(offences([/\b(setTuningValue|restoreTuning|resetTuning)\(/])).toEqual([]);
    expect(SOURCES[LOOP]).toMatch(/dev\(op: DevOp, args: number\[\], tuning\?: TuningEdit\)/);
  });

  it.todo('debug/panel.ts binds no sim table or fighter field (P37: edits go through loop.dev("setTuning", …))');

  it('calls no world, entity, joint, terrain or CombatSim mutator (dev ops are commands, RF-19)', () => {
    expect(
      offences([
        /\.(addFighter|removeFighter|spawnCreature|teleport|addEntity|removeEntity)\(/,
        /\.entities\.(create|remove|setState|anchor|unanchor|queueImpulse|release|keepAwake|restoreRecord)\(/,
        /\.joints\.(lash|hinge|rope|bend|remove|holdEnd|dropEnd|setPull|shorten|tieHeldEnd|restoreRecord)\(/,
        /\.terrain\.(generate|applyEdits|lower|raise)\(/,
        /\.(felling\.(chop|addMoment)|breaking\.(hit|loadBreak))\(/,
        /\.combat\.(add|remove|addDrop|step|beginTick|stepBody|koFighter)\(/,
        /\.sim\.commands\b/,
      ]),
    ).toEqual([]);
  });

  it('steps the world only in the game loop (rule 8: time effects change how often it steps)', () => {
    expect(offences([/\bworld\.step\(/], [LOOP])).toEqual([]);
    expect(code(SOURCES[LOOP]).filter((l) => /\bworld\.step\(/.test(l))).toHaveLength(1);
  });

  it('pushes commands only in game/loop.ts, onto world.commands', () => {
    expect(offences([/\.commands\.push\(/], [LOOP])).toEqual([]);
    const pushes = code(SOURCES[LOOP]).filter((l) => /\.commands\.push\(/.test(l));
    expect(pushes.length).toBeGreaterThan(0);
    for (const l of pushes) expect(l).toMatch(/this\.world\.commands\.push\(/);
    // The player's input goes through verbInput on its way there.
    expect(SOURCES[LOOP]).toMatch(/this\.game\.verbInput\.commands\(inp, this\.world\.tick \+ 1\)/);
  });

  it('produces player commands only in input/verbInput.ts, and dev/save commands only in the loop', () => {
    expect(offences([/\bmoveCommand\(/, /kind:\s*'(move|button|verb)'/], [VERB_INPUT])).toEqual([]);
    expect(SOURCES[VERB_INPUT]).toMatch(/moveCommand\(/);
    expect(SOURCES[VERB_INPUT]).toMatch(/kind: 'button'/);
    expect(offences([/kind:\s*'meta'/, /\bsetTuningCommand\(/], [LOOP])).toEqual([]);
  });

  it('game.ts imports no client module except the types of game/ports.ts (RF-9)', () => {
    const game = code(SOURCES['../src/game/game.ts']).join('\n');
    const statements = [...game.matchAll(/\bimport\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)'/g)].map((m) => ({ type: !!m[1], spec: m[2] }));
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      if (!s.spec.startsWith('.')) {
        expect(['three', '@wild/sim'], s.spec).toContain(s.spec);
        continue;
      }
      expect(s).toEqual({ type: true, spec: './ports' });
    }
    expect(game).not.toMatch(/\bimport\s*\(/);
    expect(game).not.toMatch(/\brequire\(/);
  });
});
