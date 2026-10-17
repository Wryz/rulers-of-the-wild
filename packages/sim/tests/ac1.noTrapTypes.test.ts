// AC-1: no trap types (SPEC:898; rule 1; docs/M1-DESIGN.md §11.1, package P24).
//
// Two checks over every file under packages/sim/src and apps/client/src:
//  1. Names. The TypeScript compiler API parses each script file (no type-check) and collects every declared name
//     (class, interface, type alias, enum, enum member, function, const and variable, property, method, parameter,
//     import, …), every string-literal type (the members of every union type alias, literal types nested in object
//     members and property signatures included: `{ type: '…' }` inside WorldEvent), the string literals given to a
//     property named kind, type, look, feature, why, effect or op, and the literals typed as one of the design's named
//     unions (MaterialId, SpeciesId, CauseFeature, MindState, VerbId, ToolClass, MomentKind, DevOp). A JSON file gives
//     every key and every string value. None may match /trap/i, so `Strap`, `Trapezoid` and `Bootstrap` fail too:
//     rename them.
//  2. The spec's literal check: a case-insensitive search for `trap` with comments removed. Comments are found with
//     the TypeScript scanner's comment ranges (getLeadingCommentRanges / getTrailingCommentRanges over every token),
//     so a `//` inside a string (a URL) or in JSX text is not taken for a comment. Every other text file in the trees
//     (CSS, HTML, shaders, …) gets the same search with its own comment syntax removed.
// A third check holds rule 1's other named example, `Deadfall`, to the names check (an addition to §11.1).
// The last block runs the same scanner over small in-memory sources, so the checks are shown not to be vacuous.
//
// Every assertion here is a GATE (§11: the criterion's meaning; it never moves).
//
// TODO(M4, rule 1's one exception): traplines (snares the player is far from, resolved statistically) arrive in M4
// and will need an explicit, named allowlist in both checks. M1 allows nothing.

import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/** One name, literal or line a check read, and where it is (`path:line:col`, 1-based). */
interface Found {
  at: string;
  what: string;
  name: string;
}

/** AC-1's search (SPEC:898). */
const TRAP = /trap/i;
/** Rule 1's three named trap types: `SpikeTrap` and `TrapType` already match TRAP; `Deadfall` doesn't. */
const NAMED_TRAP_TYPE = /trap|deadfall/i;

/** The two trees AC-1 searches, relative to the repository root. */
const TREES = ['packages/sim/src', 'apps/client/src'] as const;

const SCRIPT_KIND: Readonly<Record<string, ts.ScriptKind>> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.json': ts.ScriptKind.JSON,
};

/** Properties whose string values name a kind of thing (§11.1). */
const KIND_PROPERTIES = new Set(['kind', 'type', 'look', 'feature', 'why', 'effect', 'op']);
/** The design's named literal unions (§11.1): a literal typed as one of these is a name. */
const NAMED_UNIONS = new Set(['MaterialId', 'SpeciesId', 'CauseFeature', 'MindState', 'VerbId', 'ToolClass', 'MomentKind', 'DevOp']);

/** Files the literal search skips: they aren't text. */
const BINARY = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.ktx2', '.basis', '.hdr', '.exr', '.glb', '.bin',
  '.wasm', '.mp3', '.ogg', '.wav', '.m4a', '.flac', '.mp4', '.webm', '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);
/** Text files with only block comments (and strings that may hold `//`). */
const BLOCK_COMMENTS = new Set(['.css']);
/** Text files with block and line comments. */
const C_COMMENTS = new Set(['.scss', '.less', '.glsl', '.vert', '.frag', '.wgsl']);
/** Text files with markup comments. */
const MARKUP_COMMENTS = new Set(['.html', '.htm', '.svg', '.xml']);

function extOf(file: string): string {
  const m = /\.[^./\\]+$/.exec(file);
  return m ? m[0].toLowerCase() : '';
}

/** A script or JSON file's syntax tree (parse only, no type-check); null for any other file. */
function parse(file: string, text: string): ts.SourceFile | null {
  const kind = SCRIPT_KIND[extOf(file)];
  return kind === undefined ? null : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function where(sf: ts.SourceFile, node: ts.Node): string {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${sf.fileName}:${line + 1}:${character + 1}`;
}

/** The text of a declaration's name; null for a binding pattern or a computed name that isn't a literal. */
function nameText(name: ts.Node): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`;
  return null;
}

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

/** What a declaration is, for the report; null when the node declares no name. */
function declarationLabel(n: ts.Node): string | null {
  const exported = (label: string): string => (isExported(n) ? `exported ${label}` : label);
  switch (n.kind) {
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
      return exported('class');
    case ts.SyntaxKind.InterfaceDeclaration:
      return exported('interface');
    case ts.SyntaxKind.TypeAliasDeclaration:
      return exported('type alias');
    case ts.SyntaxKind.EnumDeclaration:
      return exported('enum');
    case ts.SyntaxKind.EnumMember:
      return 'enum member';
    case ts.SyntaxKind.ModuleDeclaration:
      return exported('namespace');
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
      return exported('function');
    case ts.SyntaxKind.VariableDeclaration:
      return exported((ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const) !== 0 ? 'const' : 'variable');
    case ts.SyntaxKind.Parameter:
      return 'parameter';
    case ts.SyntaxKind.TypeParameter:
      return 'type parameter';
    case ts.SyntaxKind.BindingElement:
      return 'binding';
    case ts.SyntaxKind.PropertyDeclaration:
      return 'property';
    case ts.SyntaxKind.PropertySignature:
      return 'property signature';
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
      return 'method';
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return 'accessor';
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.ShorthandPropertyAssignment:
      return 'object key';
    case ts.SyntaxKind.ImportClause:
    case ts.SyntaxKind.NamespaceImport:
    case ts.SyntaxKind.ImportSpecifier:
    case ts.SyntaxKind.ImportEqualsDeclaration:
      return 'import';
    case ts.SyntaxKind.NamespaceExport:
    case ts.SyntaxKind.ExportSpecifier:
      return 'export';
    case ts.SyntaxKind.JsxAttribute:
      return 'JSX attribute';
    default:
      return null;
  }
}

/** The string literals an expression can evaluate to directly (through parentheses, casts, `?:`, `??`, `||`, arrays). */
function literalsOf(e: ts.Expression): { node: ts.Node; text: string }[] {
  if (ts.isStringLiteralLike(e)) return [{ node: e, text: e.text }];
  if (ts.isTemplateExpression(e)) return [{ node: e, text: [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join('${…}') }];
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) {
    return literalsOf(e.expression);
  }
  if (ts.isConditionalExpression(e)) return [...literalsOf(e.whenTrue), ...literalsOf(e.whenFalse)];
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken) {
      return [...literalsOf(e.left), ...literalsOf(e.right)];
    }
  }
  if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((x) => (ts.isSpreadElement(x) ? [] : literalsOf(x)));
  return [];
}

/** The first of the named unions a type annotation mentions (`MaterialId`, `Record<MaterialId, …>`, `VerbId[]`, …). */
function namedUnionIn(type: ts.TypeNode): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node): void => {
    if (found !== null) return;
    if (ts.isTypeReferenceNode(n)) {
      const id = ts.isIdentifier(n.typeName) ? n.typeName : n.typeName.right;
      if (NAMED_UNIONS.has(id.text)) {
        found = id.text;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(type);
  return found;
}

/** Check 1's input: every name and kind-literal §11.1 lists, in a script or JSON file. */
function collectNames(file: string, text: string, sf: ts.SourceFile | null = parse(file, text)): Found[] {
  if (sf === null) return [];
  const out: Found[] = [];
  const seen = new Set<string>();
  const add = (node: ts.Node, what: string, name: string): void => {
    const f = { at: where(sf, node), what, name };
    const key = `${f.at}|${f.what}|${f.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  };

  if (extOf(file) === '.json') {
    const visitJson = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n)) {
        const key = nameText(n.name);
        if (key !== null) add(n.name, 'JSON key', key);
        visitJson(n.initializer);
        return;
      }
      if (ts.isStringLiteral(n)) {
        add(n, 'JSON string', n.text);
        return;
      }
      ts.forEachChild(n, visitJson);
    };
    visitJson(sf);
    return out;
  }

  const visit = (n: ts.Node): void => {
    // Declared names: class, interface, type alias, enum, enum member, function, const, property, …
    const label = declarationLabel(n);
    const declName = (n as ts.NamedDeclaration).name;
    if (label !== null && declName !== undefined) {
      const name = nameText(declName);
      if (name !== null) add(declName, label, name);
    }
    // String-literal types anywhere: union members, nested object members, property signatures.
    if (ts.isLiteralTypeNode(n) && ts.isStringLiteralLike(n.literal)) add(n, 'string literal type', n.literal.text);
    if (ts.isTemplateLiteralTypeNode(n)) {
      add(n, 'template literal type', [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join('${…}'));
    }
    // String literals given to kind, type, look, feature, why, effect, op.
    if ((ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && n.initializer !== undefined) {
      const key = nameText(n.name);
      if (key !== null && KIND_PROPERTIES.has(key)) for (const l of literalsOf(n.initializer)) add(l.node, `'${key}' value`, l.text);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) {
      const key = n.left.name.text;
      if (KIND_PROPERTIES.has(key)) for (const l of literalsOf(n.right)) add(l.node, `'${key}' value`, l.text);
    }
    // Literals typed as one of the named unions.
    if ((ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isParameter(n)) && n.type !== undefined && n.initializer !== undefined) {
      const union = namedUnionIn(n.type);
      if (union !== null) for (const l of literalsOf(n.initializer)) add(l.node, `${union} literal`, l.text);
    }
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n)) {
      const union = namedUnionIn(n.type);
      if (union !== null) for (const l of literalsOf(n.expression)) add(l.node, `${union} literal`, l.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

interface Range {
  pos: number;
  end: number;
}

const isJsxText = (n: ts.Node | undefined): boolean =>
  n !== undefined && (n.kind === ts.SyntaxKind.JsxText || n.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces);

/**
 * Every comment in a parsed file, from the TypeScript scanner's comment ranges around each token: the leading ranges
 * of a token (comments after a line break) and the trailing ranges after it (comments on the same line). A comment is
 * only ever read from trivia between tokens, so `//` inside a string, a template, a regex or JSX text is not one.
 */
function commentRanges(sf: ts.SourceFile): Range[] {
  const leaves: ts.Node[] = [];
  const collect = (n: ts.Node): void => {
    // A JSDoc node lies inside a comment; that comment is a leading range of the token after it.
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = n.getChildren(sf);
    if (children.length === 0) leaves.push(n);
    else for (const c of children) collect(c);
  };
  collect(sf);
  const ranges = new Map<number, Range>();
  const keep = (rs: ts.CommentRange[] | undefined): void => {
    for (const r of rs ?? []) ranges.set(r.pos, { pos: r.pos, end: r.end });
  };
  leaves.forEach((leaf, i) => {
    // JSX text is raw text up to the next `<` or `{`: it has no trivia, before or after.
    if (isJsxText(leaf)) return;
    keep(ts.getLeadingCommentRanges(sf.text, leaf.pos));
    if (!isJsxText(leaves[i + 1])) keep(ts.getTrailingCommentRanges(sf.text, leaf.end));
  });
  return [...ranges.values()].sort((a, b) => a.pos - b.pos);
}

/** `/* … *\/` comments (and `//` ones when asked) outside quoted strings, for the non-script text files. */
function cLikeComments(text: string, lineComments: boolean): Range[] {
  const out: Range[] = [];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote || c === '\n') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? text.length : close + 2;
      out.push({ pos: i, end });
      i = end - 1;
    } else if (lineComments && c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : nl;
      out.push({ pos: i, end });
      i = end - 1;
    }
  }
  return out;
}

function markupComments(text: string): Range[] {
  return [...text.matchAll(/<!--[\s\S]*?(?:-->|$)/g)].map((m) => ({ pos: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

/** Blanks the ranges (line breaks kept, so lines and columns still point at the source). */
function blank(text: string, ranges: Range[]): string {
  let out = '';
  let at = 0;
  for (const r of ranges) {
    out += text.slice(at, r.pos) + text.slice(r.pos, r.end).replace(/[^\r\n]/g, ' ');
    at = r.end;
  }
  return out + text.slice(at);
}

/** A file's text with its comments blanked, and how many there were; null for a binary file. */
function stripComments(file: string, text: string, sf: ts.SourceFile | null = parse(file, text)): { text: string; comments: number } | null {
  const ext = extOf(file);
  if (BINARY.has(ext)) return null;
  const ranges =
    sf !== null ? commentRanges(sf)
    : BLOCK_COMMENTS.has(ext) ? cLikeComments(text, false)
    : C_COMMENTS.has(ext) ? cLikeComments(text, true)
    : MARKUP_COMMENTS.has(ext) ? markupComments(text)
    : [];
  return { text: blank(text, ranges), comments: ranges.length };
}

/** Check 2: every `trap` (any case) left once the comments are removed, one per occurrence. */
function literalHits(file: string, text: string): Found[] {
  const stripped = stripComments(file, text);
  return stripped === null ? [] : hitsIn(file, stripped.text);
}

function hitsIn(file: string, stripped: string): Found[] {
  const out: Found[] = [];
  stripped.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/trap/gi)) {
      out.push({ at: `${file}:${i + 1}:${(m.index ?? 0) + 1}`, what: 'text', name: line.trim().slice(0, 160) });
    }
  });
  return out;
}

const matching = (found: Found[], re: RegExp): Found[] => found.filter((f) => re.test(f.name));
const report = (found: Found[]): string[] => found.map((f) => `${f.at}  ${f.what}  ${f.name}`);

/** The repository root: this file is packages/sim/tests/<file>. */
function repoRoot(): string {
  const url = (import.meta as unknown as { url: string }).url;
  let path = decodeURIComponent(url.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return path.split('/').slice(0, -4).join('/');
}

interface TreeScan {
  files: string[];
  names: Found[];
  lines: Found[];
  comments: number;
  rawHits: number;
}

function scanTrees(root: string): TreeScan {
  const scan: TreeScan = { files: [], names: [], lines: [], comments: 0, rawHits: 0 };
  for (const tree of TREES) {
    const dir = `${root}/${tree}`;
    if (!ts.sys.directoryExists(dir)) throw new Error(`AC-1: ${tree} not found under ${root}`);
    const files = ts.sys
      .readDirectory(dir)
      .map((abs) => abs.replace(/\\/g, '/'))
      .sort();
    for (const abs of files) {
      const file = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
      scan.files.push(file);
      if (BINARY.has(extOf(file))) continue;
      const text = ts.sys.readFile(abs);
      if (text === undefined) throw new Error(`AC-1: cannot read ${file}`);
      const sf = parse(file, text);
      scan.names.push(...collectNames(file, text, sf));
      const stripped = stripComments(file, text, sf);
      if (stripped !== null) {
        scan.lines.push(...hitsIn(file, stripped.text));
        scan.comments += stripped.comments;
      }
      scan.rawHits += text.match(/trap/gi)?.length ?? 0;
    }
  }
  return scan;
}

const log = (globalThis as unknown as { console: { info(...args: unknown[]): void } }).console;

describe('AC-1: no trap types (SPEC:898, rule 1)', () => {
  let scan: TreeScan;

  beforeAll(() => {
    scan = scanTrees(repoRoot());
    log.info(
      `AC-1: ${scan.files.length} files, ${scan.names.length} names and kind literals, ${scan.comments} comments removed; ` +
        `"trap" ${scan.rawHits}× in the raw text, ${scan.lines.length}× outside comments`,
    );
  });

  it('reads both trees and sees the names it should (the scan is not vacuous)', () => {
    // GATE: both trees are scanned, their script files parsed.
    for (const tree of TREES) expect(scan.files.filter((f) => f.startsWith(`${tree}/`)).length, tree).toBeGreaterThan(0);
    expect(scan.files).toContain('packages/sim/src/index.ts');
    expect(scan.files).toContain('packages/sim/src/world/types.ts');
    expect(scan.names.some((f) => f.at.startsWith('apps/client/src/')), 'names from apps/client/src').toBe(true);
    // GATE: names the design fixes are collected under the right labels (§1.5, §2).
    const has = (what: string, name: string, file: string): boolean =>
      scan.names.some((f) => f.what === what && f.name === name && f.at.startsWith(`${file}:`));
    expect(has('exported class', 'CombatSim', 'packages/sim/src/sim/combat.ts'), 'class CombatSim').toBe(true);
    expect(has('exported type alias', 'WorldEvent', 'packages/sim/src/world/types.ts'), 'type WorldEvent').toBe(true);
    expect(has('string literal type', 'impact', 'packages/sim/src/world/types.ts'), "WorldEvent { type: 'impact' }").toBe(true);
    expect(has('string literal type', 'dryWood', 'packages/sim/src/world/types.ts'), "MaterialId 'dryWood'").toBe(true);
    expect(has('string literal type', 'setTuning', 'packages/sim/src/sim/commands.ts'), "DevOp 'setTuning'").toBe(true);
  });

  it('no class, interface, type, enum, kind literal or exported name contains "trap" (§11.1 check 1)', () => {
    // GATE: rule 1. A name matching /trap/i (Strap, Trapezoid and Bootstrap included) fails: rename it.
    expect(report(matching(scan.names, TRAP)), 'AC-1: names containing "trap" (rule 1: no trap is coded as a trap)').toEqual([]);
  });

  it('a case-insensitive search for "trap" with comments removed finds nothing (§11.1 check 2, the spec\'s literal check)', () => {
    // GATE: SPEC:898's search over packages/sim/src and apps/client/src; comments are allowed, nothing else is in M1.
    expect(report(scan.lines), 'AC-1: "trap" outside comments (rule 1: no trap is coded as a trap)').toEqual([]);
  });

  it("no name or kind literal is one of rule 1's named trap types (SpikeTrap, Deadfall, TrapType)", () => {
    // GATE: rule 1 names `Deadfall` as well; /trap/i alone would not catch it.
    expect(report(matching(scan.names, NAMED_TRAP_TYPE)), 'rule 1: named trap types').toEqual([]);
  });

  describe('the scanner catches what it must (run over in-memory sources)', () => {
    const SOURCE = [
      /* 1 */ 'class SpikeTrap {}',
      /* 2 */ 'interface Deadfall { trapped: boolean; ok: number }',
      /* 3 */ "type TrapType = 'pit' | 'trapline';",
      /* 4 */ 'enum Kinds { Pit, SpikeTrapKind }',
      /* 5 */ "type WorldEvent = { type: 'impact' } | { type: 'trapSprung'; data: { inner: 'nestedTrap' } };",
      /* 6 */ "const e = { kind: 'snareTrap', look: cond ? 'stake' : 'trapLook', other: 'freeTrapText' };",
      /* 7 */ 'export function makeTrap(): void {}',
      /* 8 */ 'export const TRAP_COUNT = 1;',
      /* 9 */ "const m: MaterialId = 'trapWood';",
      /* 10 */ "const v = 'trapVerb' as VerbId;",
      /* 11 */ 'type T = `${string}Trap`;',
      /* 12 */ 'class Strap {}',
      /* 13 */ 'function bootstrap(): void {}',
      /* 14 */ 'e.why = "whyTrap";',
      /* 15 */ '// a trap in a line comment',
      /* 16 */ '/* a trap in a block comment',
      /* 17 */ '   still the comment: trap */',
      /* 18 */ '/** a trap in JSDoc */ const fine = 1; // and a trailing trap',
      /* 19 */ "const url = 'http://example.test/trap'; // the string is not a comment",
      /* 20 */ 'const re = /trap/i;',
      /* 21 */ 'const t = `a ${fine} // trap`;',
    ].join('\n');

    // Expected places are found by plain string search, independently of the parser: `file:line:col` of `needle` on
    // that line (the first occurrence), or of the "trap" inside it.
    const spot = (file: string, src: string, line: number, needle: string, offset = 0): string => {
      const col = src.split('\n')[line - 1].indexOf(needle);
      if (col < 0) throw new Error(`${needle} is not on line ${line} of ${file}`);
      return `${file}:${line}:${col + offset + 1}`;
    };
    const trapIn = (file: string, src: string, line: number, needle: string): string =>
      spot(file, src, line, needle, needle.toLowerCase().indexOf('trap'));
    const named = (line: number, needle: string, what: string, name: string): string => `${spot('mem.ts', SOURCE, line, needle)}  ${what}  ${name}`;

    it('collects every trap-named declaration and kind literal, with its place, and nothing else', () => {
      // GATE: each kind of name §11.1 lists is collected and reported where it is; `pit`, `impact`, `stake`,
      // `freeTrapText` (not a kind property; check 2 finds it) and the comments are not.
      expect(report(matching(collectNames('mem.ts', SOURCE), TRAP))).toEqual([
        named(1, 'SpikeTrap', 'class', 'SpikeTrap'),
        named(2, 'trapped', 'property signature', 'trapped'),
        named(3, 'TrapType', 'type alias', 'TrapType'),
        named(3, "'trapline'", 'string literal type', 'trapline'),
        named(4, 'SpikeTrapKind', 'enum member', 'SpikeTrapKind'),
        named(5, "'trapSprung'", 'string literal type', 'trapSprung'),
        named(5, "'nestedTrap'", 'string literal type', 'nestedTrap'),
        named(6, "'snareTrap'", "'kind' value", 'snareTrap'),
        named(6, "'trapLook'", "'look' value", 'trapLook'),
        named(7, 'makeTrap', 'exported function', 'makeTrap'),
        named(8, 'TRAP_COUNT', 'exported const', 'TRAP_COUNT'),
        named(9, "'trapWood'", 'MaterialId literal', 'trapWood'),
        named(10, "'trapVerb'", 'VerbId literal', 'trapVerb'),
        named(11, '`${string}Trap`', 'template literal type', '${…}Trap'),
        named(12, 'Strap', 'class', 'Strap'),
        named(13, 'bootstrap', 'function', 'bootstrap'),
        named(14, '"whyTrap"', "'why' value", 'whyTrap'),
      ]);
      // GATE: rule 1's `Deadfall` is caught by the named-type check, not by /trap/i.
      expect(report(matching(collectNames('mem.ts', SOURCE), NAMED_TRAP_TYPE))).toContain(named(2, 'Deadfall', 'interface', 'Deadfall'));
    });

    it('the literal search skips comments only: strings, regexes, templates and free text are searched', () => {
      // GATE: comments (line, block over two lines, JSDoc, trailing) are removed; a `//` inside a string is not one.
      const at = (line: number, needle: string): string => trapIn('mem.ts', SOURCE, line, needle);
      expect(literalHits('mem.ts', SOURCE).map((f) => f.at)).toEqual([
        at(1, 'SpikeTrap'),
        at(2, 'trapped'),
        at(3, 'TrapType'),
        at(3, 'trapline'),
        at(4, 'SpikeTrapKind'),
        at(5, 'trapSprung'),
        at(5, 'nestedTrap'),
        at(6, 'snareTrap'),
        at(6, 'trapLook'),
        at(6, 'freeTrapText'),
        at(7, 'makeTrap'),
        at(8, 'TRAP_COUNT'),
        at(9, 'trapWood'),
        at(10, 'trapVerb'),
        at(11, '${string}Trap'),
        at(12, 'Strap'),
        at(13, 'bootstrap'),
        at(14, 'whyTrap'),
        at(19, 'example.test/trap'),
        at(20, '/trap/i'),
        at(21, '// trap'),
      ]);
      // GATE: a file whose only "trap" is in comments passes; one with it in code fails.
      expect(literalHits('ok.ts', '// trap\n/* trap */\n/** trap */\nexport const fine = 1; // trap\n')).toEqual([]);
      expect(literalHits('bad.ts', 'export const s = "trap";\n').map((f) => f.at)).toEqual(['bad.ts:1:19']);
    });

    it('reads JSX text as text, not as a comment', () => {
      // GATE: `// trap` between JSX tags is page text; `/* trap */` inside `{}` is a comment.
      const tsx = 'const x = 1;\nexport const el = <div title="a">// trap {x /* trap */}</div>;\n';
      expect(literalHits('mem.tsx', tsx).map((f) => f.at)).toEqual([trapIn('mem.tsx', tsx, 2, '// trap')]);
    });

    it('reads every JSON key and string value', () => {
      // GATE: JSON keys and string values are names (§11.1).
      const json = '{\n  "trapKind": 1,\n  "look": "spikeTrap",\n  "list": ["fine", "TRAP"],\n  "ok": "stake"\n}\n';
      expect(report(matching(collectNames('mem.json', json), TRAP))).toEqual([
        `${spot('mem.json', json, 2, '"trapKind"')}  JSON key  trapKind`,
        `${spot('mem.json', json, 3, '"spikeTrap"')}  JSON string  spikeTrap`,
        `${spot('mem.json', json, 4, '"TRAP"')}  JSON string  TRAP`,
      ]);
      expect(literalHits('mem.json', json).map((f) => f.at)).toEqual([
        trapIn('mem.json', json, 2, 'trapKind'),
        trapIn('mem.json', json, 3, 'spikeTrap'),
        trapIn('mem.json', json, 4, 'TRAP'),
      ]);
    });

    it('searches other text files with their own comments removed, and skips binary files', () => {
      // GATE: a CSS class or a URL with "trap" in it is found; a CSS, HTML or shader comment is not.
      const css = '/* a trap note */\n.ok { color: red; }\n.trap-marker { background: url("http://x.test/trap.png"); }\n';
      expect(literalHits('mem.css', css).map((f) => f.at)).toEqual([trapIn('mem.css', css, 3, '.trap-marker'), trapIn('mem.css', css, 3, '/trap.png')]);
      const html = '<!-- trap -->\n<p class="trap"></p>\n';
      expect(literalHits('mem.html', html).map((f) => f.at)).toEqual([trapIn('mem.html', html, 2, '"trap"')]);
      const glsl = '// trap\n/* trap */ float trapDepth;\n';
      expect(literalHits('mem.glsl', glsl).map((f) => f.at)).toEqual([trapIn('mem.glsl', glsl, 2, 'trapDepth')]);
      expect(literalHits('mem.txt', 'trap\n').map((f) => f.at)).toEqual(['mem.txt:1:1']);
      expect(literalHits('mem.png', 'trap')).toEqual([]);
    });
  });
});
