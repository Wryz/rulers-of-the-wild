// The sim's purity (docs/M1-DESIGN.md §8.1, §13.0; package P05): nothing in packages/sim/src reads wall-clock time,
// draws unseeded randomness, applies a persistent Rapier force (code forces are impulses, C F3, except the sustained ones
// world/entities.ts adds and resets every step, P28) or snapshots the Rapier
// world (saves are records, §8.3), and nothing uses a Node API (the sim must move to a browser or a server unchanged).
// Comments don't count: every source file is parsed with the TypeScript compiler and only code is checked.
// Importing the index initialises neither Rapier nor recast (legacy tests pay only the module import).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import typescript from 'typescript';
import { describe, expect, it } from 'vitest';
import * as sim from '../src/index';

const ts = typescript;

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** obj.member accesses that are forbidden. */
const FORBIDDEN_MEMBERS = new Set(['Math.random', 'Date.now', 'performance.now', 'globalThis.performance', 'crypto.getRandomValues', 'crypto.randomUUID']);
/** Globals whose every member is forbidden (Node's process, the Web Crypto object). */
const FORBIDDEN_OBJECTS = new Set(['process', 'crypto', 'performance']);
/** Names forbidden anywhere in code: persistent Rapier forces, Rapier snapshots, wall-clock timers, Node globals. */
const FORBIDDEN_NAMES = new Set([
  'addForce',
  'addTorque',
  'addForceAtPoint',
  'takeSnapshot',
  'restoreSnapshot',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'requestAnimationFrame',
  '__dirname',
  '__filename',
  'Buffer',
  'require',
]);
/**
 * P28, DEPARTURE (C F3 "code forces are impulses, never addForce"): the one place a Rapier force may be added, for the
 * sustained code forces (EntityStore.queueForce: drags, tugs, hauls, a controller's lean), added in phase 4d and reset
 * after the step every tick (EntityStore.resetForces), so none persists. A pre-step impulse is spent in Rapier's first
 * substep, where a contact holds only a substep's share of friction, and a sustained load under the static threshold
 * crept (docs/work/ledger.md, P28 fifth pass). Only these names, only in this file, which must also reset them (below);
 * addTorque and every other check stay as they were.
 */
const ALLOWED_FORCE_FILE = 'world/entities.ts';
const ALLOWED_FORCE_NAMES = new Set(['addForce', 'addForceAtPoint']);

/** Node built-in modules (also forbidden with the `node:` prefix). */
const NODE_BUILTINS = new Set(['fs', 'path', 'os', 'url', 'util', 'crypto', 'child_process', 'worker_threads', 'module', 'events', 'stream', 'process', 'buffer', 'timers', 'perf_hooks', 'vm', 'http', 'https', 'net']);

function moduleForbidden(spec: string): boolean {
  return spec.startsWith('node:') || NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.split('/')[0]);
}

/** Every forbidden use in one source text, as "file:line: what". */
function violations(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const at = (n: typescript.Node, what: string) => out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${what}`);
  const visit = (n: typescript.Node): void => {
    if (ts.isPropertyAccessExpression(n)) {
      const obj = n.expression.getText(sf);
      if (FORBIDDEN_MEMBERS.has(`${obj}.${n.name.text}`)) at(n, `${obj}.${n.name.text}`);
      else if (ts.isIdentifier(n.expression) && FORBIDDEN_OBJECTS.has(obj)) at(n, `${obj}.${n.name.text}`);
    }
    if (ts.isIdentifier(n) && FORBIDDEN_NAMES.has(n.text) && !(file === ALLOWED_FORCE_FILE && ALLOWED_FORCE_NAMES.has(n.text))) at(n, n.text);
    if (ts.isNewExpression(n) && n.expression.getText(sf) === 'Date') at(n, 'new Date');
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'Date') at(n, 'Date()');
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && moduleForbidden(n.moduleSpecifier.text)) {
      at(n, `import '${n.moduleSpecifier.text}'`);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (!a || !ts.isStringLiteralLike(a)) at(n, 'a dynamic import of a computed module');
      else if (moduleForbidden(a.text)) at(n, `import('${a.text}')`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('sim purity', () => {
  it('packages/sim/src has no wall-clock time, unseeded randomness, Rapier forces or snapshots, or Node APIs', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(40);
    const found = files.flatMap((f) => violations(relative(SRC, f), readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });

  it('the force file adds forces only alongside their per-step reset (P28: the add-then-reset pattern)', () => {
    const text = readFileSync(join(SRC, ALLOWED_FORCE_FILE), 'utf8');
    const sf = ts.createSourceFile(ALLOWED_FORCE_FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const calls = new Set<string>();
    const visit = (n: typescript.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) calls.add(n.expression.name.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(calls.has('addForce') || calls.has('addForceAtPoint')).toBe(true);
    expect(calls.has('resetForces')).toBe(true);
    expect(calls.has('resetTorques')).toBe(true);
    // Allowed only there, and only those two: addTorque is still caught in it, and addForce anywhere else.
    expect(violations(ALLOWED_FORCE_FILE, 'body.addTorque(t, true);').length).toBeGreaterThan(0);
    expect(violations('world/joints.ts', 'body.addForce(f, true);').length).toBeGreaterThan(0);
    expect(violations(ALLOWED_FORCE_FILE, 'body.addForceAtPoint(f, p, true);')).toEqual([]);
  });

  it('catches every forbidden form in code and ignores comments (the check is not vacuous)', () => {
    const bad = [
      'const a = Math.random();',
      'const t = Date.now();',
      'const t = performance.now();',
      'const t = globalThis.performance.now();',
      'const d = new Date();',
      'const s = Date();',
      'crypto.getRandomValues(buf);',
      'const e = process.env.X;',
      'body.addForce({ x: 1, y: 0, z: 0 }, true);',
      'body.addForceAtPoint(f, p, true);',
      'body.addTorque(t, true);',
      'const s = world.takeSnapshot();',
      'setTimeout(() => {}, 1);',
      "import { readFileSync } from 'node:fs';",
      "import * as path from 'path';",
      "export * from 'node:os';",
      "const m = await import('fs');",
      "const fs = require('fs');",
      'const b = Buffer.from([1]);',
    ];
    for (const src of bad) expect(violations('sample.ts', src).length, src).toBeGreaterThan(0);
    const fine = [
      '// Math.random() and Date.now() in a comment\nconst a = 1;',
      '/* never addForce (C F3) */ const b = 2;',
      "const s = 'performance.now is not called here';",
      'contacts.process(w, pairs);',
      'class C { process(x: number) { return x; } }',
      'const jumpBufferFrames = 6;',
      "import { Vector3 } from 'three';",
      "import RAPIER from '@dimforge/rapier3d-compat';",
    ];
    for (const src of fine) expect(violations('sample.ts', src), src).toEqual([]);
  });

  it('importing the index initialises neither Rapier nor recast', () => {
    expect(typeof sim.createWorld).toBe('function');
    expect(sim.physicsInitCount()).toBe(0);
    expect(sim.isPhysicsReady()).toBe(false);
  });
});
