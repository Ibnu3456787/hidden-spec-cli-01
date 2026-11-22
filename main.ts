// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A file as lines plus its own line break and whether it ends with one (section 3). */
interface Model {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): Model {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinModel(m: Model): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** A line of N. Context lines remember which line of O they are. */
interface NLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** the patch line was empty (a context line with empty text) */
  emptyPatch: boolean;
  /** a `\` line follows it */
  noEol: boolean;
}

/** A chunk's body split into the old lines O and the new lines N (sections 5, 6, 8). */
function splitBody(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      n.push({ text: b.text, ctx: true, oIndex: o.length });
      o.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimTrail(line);
  return trimBoth(line);
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions where O occurs in lines at a tier, from `from` on; occurrences may overlap. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const keys = o.map((l) => tierKey(l, tier));
  outer: for (let i = from; i + o.length <= lines.length; i += 1) {
    for (let j = 0; j < o.length; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from` (an end-of-file chunk takes only an occurrence ending at the last line). */
function firstTier(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; occs: number[] } | null {
  for (const t of tiers(strict)) {
    let occs = occurrencesAt(lines, o, t, from);
    if (eofOnly) occs = occs.filter((i) => i + o.length === lines.length);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one; -1 when none. */
function anchorAt(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const t of tiers(strict)) {
    const key = tierKey(anchor, t);
    for (let i = from; i < lines.length; i += 1) {
      if (tierKey(lines[i]!, t) === key) return i;
    }
  }
  return -1;
}

/** N as written: context lines are the file's own matched lines; at tier 2 other lines are re-indented (section 5). */
function replacement(fileLines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const f = leadWs(fileLines[at]!);
  const p = leadWs(o[0]!);
  return n.map((e) => {
    if (e.ctx) return fileLines[at + e.oIndex]!;
    if (tier === 2) {
      const t = e.text;
      if (t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return e.text;
  });
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified diff section: one edit (section 6). A null path is `/dev/null`, no file. */
interface USection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

/** A `---`/`+++` path: after the four characters, up to the first tab, surrounding spaces removed, `a/`/`b/` stripped. */
function dashPath(s: string): string | null {
  const t = s.split('\t', 1)[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let header = false;
  let oldNamed = false;
  let newNamed = false;
  let i = 0;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const gitRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      header = true;
      oldNamed = false;
      newNamed = false;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          if (b[0] === '\\') {
            const last = hunk.body[hunk.body.length - 1];
            if (last !== undefined) last.noEol = true;
          } else if (b === '') {
            hunk.body.push({ kind: 'ctx', text: '', emptyPatch: true, noEol: false });
          } else if (b[0] === ' ') {
            hunk.body.push({ kind: 'ctx', text: b.slice(1), emptyPatch: false, noEol: false });
          } else if (b[0] === '-') {
            hunk.body.push({ kind: 'old', text: b.slice(1), emptyPatch: false, noEol: false });
          } else {
            hunk.body.push({ kind: 'new', text: b.slice(1), emptyPatch: false, noEol: false });
          }
          i += 1;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.emptyPatch) hunk.body.pop();
      cur.hunks.push(hunk);
      header = false;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (header && cur !== null) {
        if (next === undefined || !next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = dashPath(line.slice(4));
        cur.newPath = dashPath(next.slice(4));
        oldNamed = true;
        newNamed = true;
        i += 2;
        continue;
      }
      if (next !== undefined && next.startsWith('+++ ')) {
        cur = { oldPath: dashPath(line.slice(4)), newPath: dashPath(next.slice(4)), newFile: false, delFile: false, hunks: [] };
        sections.push(cur);
        header = true;
        oldNamed = true;
        newNamed = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (header && cur !== null) {
      if (line.startsWith('+++ ')) {
        cur.newPath = dashPath(line.slice(4));
        newNamed = true;
      } else if (line.startsWith('rename from ') && !oldNamed) {
        cur.oldPath = line.slice('rename from '.length).trim();
        oldNamed = true;
      } else if (line.startsWith('rename to ') && !newNamed) {
        cur.newPath = line.slice('rename to '.length).trim();
        newNamed = true;
      } else if (line.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(hunk: Hunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k -= 1) {
    const b = hunk.body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') return b.noEol;
  }
  return false;
}

/** Apply one hunk to the model; returns N's length minus O's length, for the drift d. */
function applyHunk(model: Model, hunk: Hunk, d: number, strict: boolean, path: string): number {
  const { o, n } = splitBody(hunk.body);
  if (o.length > 0) {
    const found = firstTier(model.lines, o, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.occs[0]!;
    for (const at of found.occs) {
      if (Math.abs(at - target) < Math.abs(best - target)) best = at;
    }
    const atEnd = best + o.length === model.lines.length;
    const rep = replacement(model.lines, best, o, n, found.tier);
    model.lines.splice(best, o.length, ...rep);
    if (atEnd) model.final = !hunkNoEol(hunk);
  } else {
    const pos = Math.min(Math.max(hunk.a + d, 0), model.lines.length);
    const atEnd = pos === model.lines.length;
    model.lines.splice(pos, 0, ...n.map((e) => e.text));
    if (atEnd) model.final = !hunkNoEol(hunk);
  }
  return n.length - o.length;
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => (tree: Tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP === null && newP === null) return;
    if (oldP === null || sec.newFile) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') {
            plus.push(b.text);
            noEol = b.noEol;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : `${plus.join('\n')}${noEol ? '' : '\n'}`);
      return;
    }
    if (newP === null || sec.delFile) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const model = splitText(before);
      let d = 0;
      for (const h of sec.hunks) d += applyHunk(model, h, d, strict, oldP);
      tree.now.set(newP, joinModel(model));
      tree.now.set(oldP, null);
      moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const model = splitText(before);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(model, h, d, strict, oldP);
    tree.now.set(oldP, joinModel(model));
  });
}

/** One SEARCH/REPLACE block (section 7). */
interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    blocks.push({ path, old: lines.slice(s + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.nw.length === 0 ? '' : `${b.nw.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = splitText(before);
    const found = firstTier(model.lines, b.old, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occs.length !== 1) throw new Fail('ambiguous', b.path);
    const at = found.occs[0]!;
    const n: NLine[] = b.nw.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    model.lines.splice(at, b.old.length, ...replacement(model.lines, at, b.old, n, found.tier));
    tree.now.set(b.path, joinModel(model));
  });
}

/** One V4A chunk (section 8). */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

type VSection =
  | { kind: 'add'; path: string; content: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const starts = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
  const isStart = (l: string): boolean => starts.some((p) => l.startsWith(p));
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const startIdx = i;
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    const content: Array<{ line: string; idx: number }> = [];
    let j = i + 1;
    while (j < last && !isStart(lines[j]!)) {
      content.push({ line: lines[j]!, idx: j });
      j += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.line)) content.pop();
    if (kind === 'add') {
      const out: string[] = [];
      for (const c of content) {
        if (c.line.startsWith('+')) out.push(c.line.slice(1));
        else if (c.line === '') out.push('');
        else throw new Exit2(`error: parse ${c.idx + 1}`);
      }
      sections.push({ kind: 'add', path, content: out });
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.idx + 1}`);
      sections.push({ kind: 'delete', path });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (content.length > 0 && content[0]!.line.startsWith('*** Move to: ')) {
        moveTo = content[0]!.line.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < content.length; k += 1) {
        const c = content[k]!;
        const l = c.line;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(cur);
        } else if (l === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            chunks.push(cur);
          } else {
            cur.eof = true;
          }
          cur = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '', emptyPatch: true, noEol: false });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1), emptyPatch: false, noEol: false });
          else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1), emptyPatch: false, noEol: false });
          else cur.body.push({ kind: 'new', text: l.slice(1), emptyPatch: false, noEol: false });
        } else {
          throw new Exit2(`error: parse ${c.idx + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startIdx + 1}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
    }
    i = j;
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((sec) => (tree: Tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.content.length === 0 ? '' : `${sec.content.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const oldP = sec.path;
    const newP = sec.moveTo;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (newP !== null && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = splitText(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const at = anchorAt(model.lines, chunk.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', oldP);
        cursor = at + 1;
      }
      const { o, n } = splitBody(chunk.body);
      if (o.length > 0) {
        const found = firstTier(model.lines, o, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', oldP);
        const at = found.occs[0]!;
        model.lines.splice(at, o.length, ...replacement(model.lines, at, o, n, found.tier));
        cursor = at + n.length;
      } else {
        const pos = chunk.eof ? model.lines.length : cursor;
        model.lines.splice(pos, 0, ...n.map((e) => e.text));
        cursor = pos + n.length;
      }
    }
    const out = joinModel(model);
    if (newP !== null) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) === null) continue;
    if (tree.get(oldP) !== null) continue;
    if (tree.original(newP) !== null) continue;
    if (tree.get(newP) === null) continue;
    covered.add(oldP);
    covered.add(newP);
    rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!covered.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
