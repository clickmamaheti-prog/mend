// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  /** Moves that succeeded, in patch order: {old, new} (SPEC.md section 2, R lines). */
  readonly moves: Array<{ old: string; new: string }> = [];
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

/** Split a file's text into lines at its own line break (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: '\r\n' | '\n'; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

/** Join lines back with the file's own break; a file of no lines is written empty. */
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** One line compared at one tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: 0 | 1 | 2): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based start position where O matches the file's lines at the tier; overlapping allowed. */
function findOccurrences(fileLines: string[], oldLines: string[], tier: 0 | 1 | 2): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  if (n === 0) return out;
  for (let i = 0; i + n <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!lineEq(fileLines[i + j]!, oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only with --strict) at which O occurs at least once. */
function matchTier(fileLines: string[], oldLines: string[], strict: boolean): { tier: 0 | 1 | 2; positions: number[] } | null {
  const tiers: Array<0 | 1 | 2> = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = findOccurrences(fileLines, oldLines, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Tier-2 re-indentation (SPEC.md section 5): a non-blank line of N starting with P has P replaced by F. */
function reindent(newLines: string[], oldFirst: string, fileFirst: string): string[] {
  const f = leadWs(fileFirst);
  const p = leadWs(oldFirst);
  return newLines.map((l) => {
    if (l === '' || l.trim() === '') return l;
    if (!l.startsWith(p)) return l;
    return f + l.slice(p.length);
  });
}

/** One line of N: a context line is written as the file's own matched line (oIdx: its index in O). */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Replace the O lines at position `pos` with N, honouring context lines and tier-2 re-indentation. */
function applyReplacement(fileLines: string[], pos: number, o: string[], n: NLine[], tier: 0 | 1 | 2): string[] {
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(o[0] ?? '');
  const rep: string[] = [];
  for (const e of n) {
    if (e.ctx) rep.push(fileLines[pos + e.oIdx]!);
    else if (tier === 2) {
      const l = e.text;
      rep.push(l === '' || l.trim() === '' || !l.startsWith(p) ? l : f + l.slice(p.length));
    } else rep.push(e.text);
  }
  return [...fileLines.slice(0, pos), ...rep, ...fileLines.slice(pos + o.length)];
}

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

/** One body line of a unified hunk; noEol is set when a `\` line follows it. */
interface HunkBodyItem {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  noEol: boolean;
}
interface Hunk {
  a: number;
  body: HunkBodyItem[];
}
/** One unified section; hdr/ren are undefined when that source named no path, null for /dev/null. */
interface UnifiedSection {
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  dgOld: string;
  dgNew: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: text up to the first tab, surrounding spaces removed. */
function parseHeaderPath(s: string): string {
  return s.split('\t')[0]!.trim();
}

/** A leading `a/` or `b/` is removed from either path. */
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** `diff --git a/<X> b/<Y>`, or null when the line is not of that form. */
function parseDiffGit(line: string): { old: string; new: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const old = rest.slice(2, sep);
  const nw = rest.slice(sep + 3).trimEnd();
  if (old === '' || nw === '') return null;
  return { old, new: nw };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;

/** Read a unified patch (SPEC.md section 6) into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const startSection = (dg: { old: string; new: string } | null): UnifiedSection => {
    const s: UnifiedSection = {
      hdrOld: undefined,
      hdrNew: undefined,
      renOld: undefined,
      renNew: undefined,
      dgOld: dg?.old ?? '',
      dgNew: dg?.new ?? '',
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dg = parseDiffGit(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(dg);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A header pair: part of this section's header, or the start of a new section.
      if (cur === null || !inHeader) startSection(null);
      const s = cur!;
      const oldRaw = parseHeaderPath(line.slice(4));
      const newRaw = parseHeaderPath((lines[i + 1]!).slice(4));
      s.hdrOld = oldRaw === '/dev/null' ? null : stripAB(oldRaw);
      s.hdrNew = newRaw === '/dev/null' ? null : stripAB(newRaw);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i++;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          if (b === '') hunk.body.push({ kind: ' ', text: '', noEol: false });
          else hunk.body.push({ kind: b[0] as ' ' | '-' | '+' | '\\', text: b.slice(1), noEol: false });
          i++;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      // A `\` line refers to the body line before it.
      for (let k = 0; k < hunk.body.length; k++) {
        if (hunk.body[k]!.kind === '\\') {
          for (let j = k - 1; j >= 0; j--) {
            if (hunk.body[j]!.kind !== '\\') {
              hunk.body[j]!.noEol = true;
              break;
            }
          }
        }
      }
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        if (cur.renOld === undefined) cur.renOld = stripAB(line.slice('rename from '.length).trim());
      } else if (line.startsWith('rename to ')) {
        if (cur.renNew === undefined) cur.renNew = stripAB(line.slice('rename to '.length).trim());
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
      }
      // index, old/new mode, similarity/dissimilarity index, Index: and any other line: ignored.
      i++;
      continue;
    }
    // Outside bodies and headers: ignored (prose, code fences).
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** `---`/`+++` wins over `rename from/to`, which wins over the `diff --git` paths. */
function resolveUnifiedPath(hdr: string | null | undefined, ren: string | undefined, dg: string): string | null {
  if (hdr !== undefined) return hdr;
  if (ren !== undefined) return ren;
  return dg;
}

/** Apply a section's hunks in order to a file's text, tracking the running length delta d. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let { lines, br, final } = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: NLine[] = [];
    for (const item of h.body) {
      if (item.kind === ' ') {
        o.push(item.text);
        n.push({ text: item.text, ctx: true, oIdx: o.length - 1 });
      } else if (item.kind === '-') o.push(item.text);
      else if (item.kind === '+') n.push({ text: item.text, ctx: false, oIdx: -1 });
    }
    let lastNoEol = false;
    for (let k = h.body.length - 1; k >= 0; k--) {
      const it = h.body[k]!;
      if (it.kind === ' ' || it.kind === '+') {
        lastNoEol = it.noEol;
        break;
      }
    }
    if (o.length === 0) {
      const insertPos = Math.min(Math.max(h.a + d, 0), lines.length);
      lines = [...lines.slice(0, insertPos), ...n.map((e) => e.text), ...lines.slice(insertPos)];
      if (insertPos === lines.length) final = !lastNoEol;
      d += n.length;
    } else {
      const m = matchTier(lines, o, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = m.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of m.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const pos = best;
      const matchedToEnd = pos + o.length === lines.length;
      lines = applyReplacement(lines, pos, o, n, m.tier);
      if (matchedToEnd) final = !lastNoEol;
      d += n.length - o.length;
    }
  }
  return joinFile(lines, br, final);
}

function unifiedSectionEdit(s: UnifiedSection, strict: boolean): Edit {
  const oldP = resolveUnifiedPath(s.hdrOld, s.renOld, s.dgOld);
  const newP = resolveUnifiedPath(s.hdrNew, s.renNew, s.dgNew);
  const creation = oldP === null || s.newFile;
  const deletion = !creation && (newP === null || s.deletedFile);
  const move = !creation && !deletion && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (creation) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let final = true;
      for (const h of s.hunks) {
        for (const item of h.body) {
          if (item.kind === '+') plus.push(item.text);
        }
        for (let k = h.body.length - 1; k >= 0; k--) {
          if (h.body[k]!.kind === '+') {
            final = !h.body[k]!.noEol;
            break;
          }
        }
      }
      tree.now.set(np, joinFile(plus, '\n', final));
    } else if (deletion) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    } else if (move) {
      const op = oldP!;
      const np = newP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const result = applyHunks(tree.get(op)!, s.hunks, strict, op);
      tree.now.set(np, result);
      tree.now.set(op, null);
      tree.moves.push({ old: op, new: np });
    } else {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(tree.get(p)!, s.hunks, strict, p));
    }
  };
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
function searchReplaceBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(newLines, '\n', true));
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(cur);
    const m = matchTier(lines, oldLines, strict);
    if (m === null) throw new Fail('no-match', path);
    if (m.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = m.positions[0]!;
    const rep = m.tier === 2 ? reindent(newLines, oldLines[0]!, lines[pos]!) : [...newLines];
    const out = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(out, br, final));
  };
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7) into one edit per block. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    // The path is the nearest line before SEARCH, after the previous block's REPLACE,
    // that is not blank and does not start with three backticks (trimmed).
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= searchFrom; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
    }
    let repIdx = -1;
    if (eqIdx >= 0) {
      for (let j = eqIdx + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          repIdx = j;
          break;
        }
      }
    }
    if (eqIdx < 0 || repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceBlockEdit(path, lines.slice(searchIdx + 1, eqIdx), lines.slice(eqIdx + 1, repIdx), strict));
    prevPath = path;
    searchFrom = repIdx + 1;
    i = repIdx + 1;
  }
  return edits;
}

/** One V4A chunk: an anchor (null = none), whether `*** End of File` ended it, and its body. */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: Array<{ kind: ' ' | '-' | '+'; text: string }>;
}
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
  lineNo: number;
}

/** The first line at or after the cursor equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const tiers: Array<0 | 1 | 2> = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** matchTier restricted to occurrences starting at or after `from`. */
function matchTierFrom(lines: string[], oldLines: string[], from: number, strict: boolean): { tier: 0 | 1 | 2; positions: number[] } | null {
  const tiers: Array<0 | 1 | 2> = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = findOccurrences(lines, oldLines, t).filter((p) => p >= from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** Read a V4A patch (SPEC.md section 8) into one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const sec: V4aSection = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), moveTo: null, addLines: [], chunks: [], lineNo: i + 1 };
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l.startsWith('+')) {
          sec.addLines.push(l.slice(1));
          i++;
        } else if (l === '') {
          sec.addLines.push('');
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it.
      while (sec.addLines.length > 0 && sec.addLines[sec.addLines.length - 1] === '') sec.addLines.pop();
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      sections.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim(), moveTo: null, addLines: [], chunks: [], lineNo: i + 1 });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const sec: V4aSection = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), moveTo: null, addLines: [], chunks: [], lineNo: i + 1 };
      i++;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      let curChunk: V4aChunk | null = null;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          sec.chunks.push(curChunk);
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          curChunk = null;
          i++;
          continue;
        }
        if (l.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (sec.chunks.length === 0) {
              curChunk = { anchor: null, eof: false, body: [] };
              sec.chunks.push(curChunk);
            } else throw new Exit2(`error: parse ${i + 1}`);
          }
          if (l === '') curChunk.body.push({ kind: ' ', text: '' });
          else curChunk.body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it.
      if (sec.chunks.length > 0) {
        const lastChunk = sec.chunks[sec.chunks.length - 1]!;
        while (lastChunk.body.length > 0) {
          const b = lastChunk.body[lastChunk.body.length - 1]!;
          if (b.kind === ' ' && b.text === '') lastChunk.body.pop();
          else break;
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, joinFile(s.addLines, '\n', true));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let { lines, br, final } = splitFile(cur);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const a = findAnchor(lines, chunk.anchor, cursor, strict);
        if (a === null) throw new Fail('no-match', s.path);
        cursor = a + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const item of chunk.body) {
        if (item.kind === ' ') {
          o.push(item.text);
          n.push({ text: item.text, ctx: true, oIdx: o.length - 1 });
        } else if (item.kind === '-') o.push(item.text);
        else if (item.kind === '+') n.push({ text: item.text, ctx: false, oIdx: -1 });
      }
      if (o.length === 0) {
        const insertPos = chunk.eof ? lines.length : cursor;
        lines = [...lines.slice(0, insertPos), ...n.map((e) => e.text), ...lines.slice(insertPos)];
        cursor = insertPos + n.length;
      } else {
        const m = matchTierFrom(lines, o, cursor, strict);
        if (m === null) throw new Fail('no-match', s.path);
        let pos = m.positions[0]!;
        if (chunk.eof) {
          const ok = m.positions.filter((p) => p + o.length === lines.length);
          if (ok.length === 0) throw new Fail('no-match', s.path);
          pos = ok[0]!;
        }
        lines = applyReplacement(lines, pos, o, n, m.tier);
        cursor = pos + n.length;
      }
    }
    const result = joinFile(lines, br, final);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, result);
      tree.now.set(s.path, null);
      tree.moves.push({ old: s.path, new: s.moveTo });
    } else {
      tree.now.set(s.path, result);
    }
  };
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
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : [];
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
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
