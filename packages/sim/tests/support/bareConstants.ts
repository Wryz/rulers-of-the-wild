// P38 (docs/M1-DESIGN.md §9, RR-7): the no-bare-constants scan. Every starting value lives in a live tuning table
// (SPEC:12; CLAUDE.md "Every starting value goes in a live tuning table"), so a numeric literal in the scanned code is
// a finding unless it is
// - inside a defineTuning(...) call (the table and its field metadata), or a panel range of field metadata written
//   beside one (`min`, `max`, `step`);
// - a literal type (`n: 2 | 3 | 4`), which is a type, not a value;
// - one of ANYWHERE's maths constants, or a numerical tolerance no bigger than EPSILON_MAX;
// - allowed for its file by the caller's allowlist, each value with its reason (bit masks, Recast's limits, byte
//   sizes, unit conversions, formula constants, DS fixtures).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/** Values allowed anywhere: maths, not tuning. */
export const ANYWHERE: Readonly<Record<string, string>> = {
  '0': 'zero',
  '1': 'one (a unit, a count of one, an index)',
  '-1': 'minus one (a sign flip, "none" for an index)',
  '2': 'two (halving, doubling, squaring, pairs)',
  '0.5': 'a half',
  '-0.5': 'minus a half (a unit quaternion component, a centred offset)',
  '3': 'three: x, y, z (vector strides and loops), thirds in exact formulas (a centroid, 4/3·π·r³)',
  '4': "four: a quaternion's numbers, quarters in exact formulas (a quarter turn, a tetrahedron's centroid)",
  '180': 'degrees to radians (π / 180)',
  '360': 'degrees in a turn',
};

/** |v| at or below this is a numerical tolerance (float comparisons, divide-by-zero guards), never a starting value. */
export const EPSILON_MAX = 1e-6;

/** Per file (path relative to the scanned root, '/' separated): value (as written by String(Number(text))) → reason. */
export type FileAllowlist = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface BareConstant {
  file: string;
  line: number;
  value: number;
  text: string;
}

/** Every .ts file under `dir`, sorted, as paths relative to `root` with '/' separators. */
export function tsFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(join(root, dir));
  return out;
}

const RANGE_KEYS = new Set(['min', 'max', 'step']);

/** The numeric literals of `files` (relative to `root`) that no rule above allows. */
export function bareConstants(root: string, files: readonly string[], allow: FileAllowlist): BareConstant[] {
  const out: BareConstant[] = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const lines = text.split('\n');
    const fileAllow = allow[file] ?? {};
    const visit = (n: ts.Node, inTable: boolean): void => {
      if (ts.isCallExpression(n) && n.expression.getText(src) === 'defineTuning') inTable = true;
      if (ts.isLiteralTypeNode(n)) return;
      if (ts.isNumericLiteral(n) && !inTable) {
        let v = Number(n.text);
        const p = n.parent;
        if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.MinusToken) v = -v;
        const key = String(v);
        const range = ts.isPropertyAssignment(p) && RANGE_KEYS.has(p.name.getText(src));
        if (!range && !(key in ANYWHERE) && !(Math.abs(v) <= EPSILON_MAX) && !(key in fileAllow)) {
          const line = src.getLineAndCharacterOfPosition(n.getStart(src)).line;
          out.push({ file, line: line + 1, value: v, text: lines[line].trim() });
        }
      }
      ts.forEachChild(n, (c) => visit(c, inTable));
    };
    visit(src, false);
  }
  return out;
}

/** Allowlist entries (file, value) that no literal uses any more: stale reasons to drop. */
export function unusedAllowances(root: string, allow: FileAllowlist): string[] {
  const out: string[] = [];
  for (const [file, values] of Object.entries(allow)) {
    const text = readFileSync(join(root, file), 'utf8');
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const seen = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isNumericLiteral(n)) {
        let v = Number(n.text);
        if (ts.isPrefixUnaryExpression(n.parent) && n.parent.operator === ts.SyntaxKind.MinusToken) v = -v;
        seen.add(String(v));
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    for (const v of Object.keys(values)) if (!seen.has(v)) out.push(`${file}: ${v}`);
  }
  return out;
}
