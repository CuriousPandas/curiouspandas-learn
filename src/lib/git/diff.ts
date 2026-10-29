// Line diff and three-way merge, small enough to read in one sitting.
//
// The merge follows diff3: lines that survive unchanged in both sides are sync
// points, and only the stretches between them can conflict. That is why two
// edits on *adjacent* lines conflict in real git while edits further apart
// merge cleanly - a learner who sees that here and then sees the same thing in
// git has learned something true. A whole-file merge would be simpler and would
// teach the opposite.

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function joinLines(lines: string[]): string {
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Longest common subsequence as a map from index in `a` to index in `b`. */
export function lcsMap(a: string[], b: string[]): Map<number, number> {
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const map = new Map<number, number>();
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { map.set(i, j); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return map;
}

export type DiffOp = { op: ' ' | '-' | '+'; line: string };

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const map = lcsMap(a, b);
  const out: DiffOp[] = [];
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    const mj = map.get(i);
    if (mj === undefined) { out.push({ op: '-', line: a[i] }); continue; }
    while (j < mj) out.push({ op: '+', line: b[j++] });
    out.push({ op: ' ', line: a[i] });
    j = mj + 1;
  }
  while (j < b.length) out.push({ op: '+', line: b[j++] });
  return out;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);

export function merge3(
  base: string, ours: string, theirs: string, oursLabel: string, theirsLabel: string,
): { text: string; conflict: boolean } {
  const o = splitLines(base), a = splitLines(ours), b = splitLines(theirs);
  const ma = lcsMap(o, a), mb = lcsMap(o, b);
  const out: string[] = [];
  let conflict = false;
  let i = 0, ia = 0, ib = 0;

  const emitChunk = (bo: string[], ba: string[], bb: string[]) => {
    if (same(ba, bo)) out.push(...bb);
    else if (same(bb, bo)) out.push(...ba);
    else if (same(ba, bb)) out.push(...ba);
    else {
      // git's default "zealous" level: lines both sides agree on at the edges
      // of a conflict are pulled out of it, so the markers wrap only the
      // disagreement. Without this, conflict files differ from git's.
      let pre = 0;
      while (pre < ba.length && pre < bb.length && ba[pre] === bb[pre]) pre++;
      let suf = 0;
      while (suf < ba.length - pre && suf < bb.length - pre &&
        ba[ba.length - 1 - suf] === bb[bb.length - 1 - suf]) suf++;
      out.push(...ba.slice(0, pre));
      out.push(`<<<<<<< ${oursLabel}`, ...ba.slice(pre, ba.length - suf), '=======',
        ...bb.slice(pre, bb.length - suf), `>>>>>>> ${theirsLabel}`);
      out.push(...ba.slice(ba.length - suf));
      conflict = true;
    }
  };

  while (true) {
    let j = i;
    while (j < o.length && !(ma.has(j) && mb.has(j))) j++;
    if (j >= o.length) {
      emitChunk(o.slice(i), a.slice(ia), b.slice(ib));
      break;
    }
    const ja = ma.get(j)!, jb = mb.get(j)!;
    if (j > i || ja > ia || jb > ib) emitChunk(o.slice(i, j), a.slice(ia, ja), b.slice(ib, jb));
    out.push(o[j]);
    i = j + 1; ia = ja + 1; ib = jb + 1;
  }
  return { text: joinLines(out), conflict };
}
