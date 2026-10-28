// P38 (docs/M1-DESIGN.md §9, RR-7): the no-bare-constants scan. Every starting value lives in a live tuning table
// (SPEC:12; CLAUDE.md "Every starting value goes in a live tuning table"), so a numeric literal in the scanned code is
// a finding unless it is
// - inside a defineTuning(...) call (the table and its field metadata), or a panel range of field metadata written
//   beside one (`min`, `max`, `step`);
// - a literal type (`n: 2 | 3 | 4`), which is a type, not a value;
// - one of ANYWHERE's maths constants, or a numerical tolerance no bigger than EPSILON_MAX;
// - allowed for its file by the caller's allowlist, each value with its reason (bit masks, Recast's limits, byte
//   sizes, unit conversions, formula constants, DS fixtures), each tied to its site: the value and a pattern its source
//   line must match, so an allowance covers that use only, not every use of the value in the file.
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

/** One allowed site: the value (as String(Number(text)) writes it), a pattern its source line matches, and why. */
export interface Allowance {
  v: string;
  at: RegExp;
  why: string;
}

/** Per file (path relative to the scanned root, '/' separated): its allowed sites. */
export type FileAllowlist = Readonly<Record<string, readonly Allowance[]>>;

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

interface Literal {
  value: number;
  key: string;
  line: number;
  text: string;
}

/** Every numeric literal of a file the scan judges: not in a tuning table, not a literal type, not a panel range. */
function judgedLiterals(root: string, file: string): Literal[] {
  const text = readFileSync(join(root, file), 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = text.split('\n');
  const out: Literal[] = [];
  const visit = (n: ts.Node, inTable: boolean): void => {
    if (ts.isCallExpression(n) && n.expression.getText(src) === 'defineTuning') inTable = true;
    if (ts.isLiteralTypeNode(n)) return;
    if (ts.isNumericLiteral(n) && !inTable) {
      let v = Number(n.text);
      const p = n.parent;
      if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.MinusToken) v = -v;
      const range = ts.isPropertyAssignment(p) && RANGE_KEYS.has(p.name.getText(src));
      if (!range) {
        const line = src.getLineAndCharacterOfPosition(n.getStart(src)).line;
        out.push({ value: v, key: String(v), line: line + 1, text: lines[line].trim() });
      }
    }
    ts.forEachChild(n, (c) => visit(c, inTable));
  };
  visit(src, false);
  return out;
}

const allowedAt = (allow: readonly Allowance[], l: Literal): boolean => allow.some((a) => a.v === l.key && a.at.test(l.text));

/** The numeric literals of `files` (relative to `root`) that no rule above allows. */
export function bareConstants(root: string, files: readonly string[], allow: FileAllowlist): BareConstant[] {
  const out: BareConstant[] = [];
  for (const file of files) {
    for (const l of judgedLiterals(root, file)) {
      if (l.key in ANYWHERE || Math.abs(l.value) <= EPSILON_MAX || allowedAt(allow[file] ?? [], l)) continue;
      out.push({ file, line: l.line, value: l.value, text: l.text });
    }
  }
  return out;
}

/**
 * Allowances no judged literal uses (a literal inside a tuning table, a literal type or a panel range doesn't count):
 * stale reasons to drop.
 */
export function unusedAllowances(root: string, allow: FileAllowlist): string[] {
  const out: string[] = [];
  for (const [file, sites] of Object.entries(allow)) {
    const lits = judgedLiterals(root, file);
    for (const a of sites) if (!lits.some((l) => l.key === a.v && a.at.test(l.text))) out.push(`${file}: ${a.v} at ${a.at}`);
  }
  return out;
}
