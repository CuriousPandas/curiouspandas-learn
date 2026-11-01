// A port of the sort in CPython's Objects/listobject.c (3.11 and 3.12, whose sort
// code is identical; 3.13 changed run detection). It makes the same comparisons
// in the same order, using only "less than", which is why it is here rather than
// JavaScript's Array.sort:
//  - a counting __lt__ reports the numbers real Python reports. Array.sort with a
//    three-way comparator made 1,998 comparisons on 1,000 sorted items, and real
//    Python makes 999, so a lesson claiming n-1 would have been refuted by its own lab.
//  - an ordering that lies (NaN) gives real Python's wrong answer at every size,
//    not merely a wrong answer. V8's sort happened to agree on short lists only.
// tests/py-sort-parity.test.ts holds it to the real interpreter.

const MIN_GALLOP = 7;

type Run = { base: number; len: number; power: number };

export function listsort<K, V = K>(keys: K[], values: V[] | null, lt: (a: K, b: K) => boolean, reverse = false): void {
  const total = keys.length;
  if (total < 2) return;
  if (reverse) { keys.reverse(); values?.reverse(); }

  let minGallop = MIN_GALLOP;
  const pending: Run[] = [];

  // Moves within keys (and, in step, values). Overlap-safe in the direction used.
  const copyUp = (to: number, from: number, n: number) => {
    for (let i = 0; i < n; i++) { keys[to + i] = keys[from + i]; if (values) values[to + i] = values[from + i]; }
  };

  function binarysort(lo: number, hi: number, start: number) {
    if (lo === start) start++;
    for (; start < hi; start++) {
      let l = lo, r = start;
      const pivot = keys[start], pv = values?.[start];
      do {
        const p = l + ((r - l) >> 1);
        if (lt(pivot, keys[p])) r = p; else l = p + 1;
      } while (l < r);
      for (let p = start; p > l; p--) { keys[p] = keys[p - 1]; if (values) values[p] = values[p - 1]; }
      keys[l] = pivot;
      if (values) values[l] = pv as V;
    }
  }

  function countRun(lo: number, hi: number): { n: number; descending: boolean } {
    let at = lo + 1;
    if (at === hi) return { n: 1, descending: false };
    let n = 2;
    if (lt(keys[at], keys[at - 1])) {
      for (at++; at < hi; at++, n++) if (!lt(keys[at], keys[at - 1])) break;
      return { n, descending: true };
    }
    for (at++; at < hi; at++, n++) if (lt(keys[at], keys[at - 1])) break;
    return { n, descending: false };
  }

  // a[k-1] < key <= a[k], searching outward from hint.
  function gallopLeft(key: K, a: K[], base: number, n: number, hint: number): number {
    let lastofs = 0, ofs = 1;
    const at = base + hint;
    if (lt(a[at], key)) {
      const maxofs = n - hint;
      while (ofs < maxofs) {
        if (lt(a[at + ofs], key)) { lastofs = ofs; ofs = (ofs << 1) + 1; } else break;
      }
      if (ofs > maxofs) ofs = maxofs;
      lastofs += hint; ofs += hint;
    } else {
      const maxofs = hint + 1;
      while (ofs < maxofs) {
        if (lt(a[at - ofs], key)) break;
        lastofs = ofs; ofs = (ofs << 1) + 1;
      }
      if (ofs > maxofs) ofs = maxofs;
      const k = lastofs;
      lastofs = hint - ofs; ofs = hint - k;
    }
    lastofs++;
    while (lastofs < ofs) {
      const m = lastofs + ((ofs - lastofs) >> 1);
      if (lt(a[base + m], key)) lastofs = m + 1; else ofs = m;
    }
    return ofs;
  }

  // a[k-1] <= key < a[k]: the same, landing right of any equal items.
  function gallopRight(key: K, a: K[], base: number, n: number, hint: number): number {
    let lastofs = 0, ofs = 1;
    const at = base + hint;
    if (lt(key, a[at])) {
      const maxofs = hint + 1;
      while (ofs < maxofs) {
        if (lt(key, a[at - ofs])) { lastofs = ofs; ofs = (ofs << 1) + 1; } else break;
      }
      if (ofs > maxofs) ofs = maxofs;
      const k = lastofs;
      lastofs = hint - ofs; ofs = hint - k;
    } else {
      const maxofs = n - hint;
      while (ofs < maxofs) {
        if (lt(key, a[at + ofs])) break;
        lastofs = ofs; ofs = (ofs << 1) + 1;
      }
      if (ofs > maxofs) ofs = maxofs;
      lastofs += hint; ofs += hint;
    }
    lastofs++;
    while (lastofs < ofs) {
      const m = lastofs + ((ofs - lastofs) >> 1);
      if (lt(key, a[base + m])) ofs = m; else lastofs = m + 1;
    }
    return ofs;
  }

  function mergeLo(sa: number, naIn: number, sbIn: number, nbIn: number) {
    let na = naIn, nb = nbIn, sb = sbIn, dest = sa, pa = 0;
    const tk = keys.slice(sa, sa + na), tv = values ? values.slice(sa, sa + na) : null;
    const fromA = (n: number) => { for (let i = 0; i < n; i++) { keys[dest + i] = tk[pa + i]; if (values) values[dest + i] = tv![pa + i]; } dest += n; pa += n; };
    const fromB = (n: number) => { copyUp(dest, sb, n); dest += n; sb += n; };
    const copyB = () => { fromB(nb); fromA(1); };

    fromB(1); nb--;
    if (nb === 0) { fromA(na); return; }
    if (na === 1) { copyB(); return; }

    let mg = minGallop;
    for (;;) {
      let acount = 0, bcount = 0;
      for (;;) {
        if (lt(keys[sb], tk[pa])) {
          fromB(1); bcount++; acount = 0; nb--;
          if (nb === 0) { fromA(na); return; }
          if (bcount >= mg) break;
        } else {
          fromA(1); acount++; bcount = 0; na--;
          if (na === 1) { copyB(); return; }
          if (acount >= mg) break;
        }
      }
      mg++;
      do {
        mg -= mg > 1 ? 1 : 0;
        minGallop = mg;
        let k = gallopRight(keys[sb], tk, pa, na, 0);
        acount = k;
        if (k) {
          fromA(k); na -= k;
          if (na === 1) { copyB(); return; }
          // Impossible if the comparison is consistent, and it may not be.
          if (na === 0) return;
        }
        fromB(1); nb--;
        if (nb === 0) { fromA(na); return; }

        k = gallopLeft(tk[pa], keys, sb, nb, 0);
        bcount = k;
        if (k) {
          fromB(k); nb -= k;
          if (nb === 0) { fromA(na); return; }
        }
        fromA(1); na--;
        if (na === 1) { copyB(); return; }
      } while (acount >= MIN_GALLOP || bcount >= MIN_GALLOP);
      mg++;
      minGallop = mg;
    }
  }

  function mergeHi(saIn: number, naIn: number, sbIn: number, nbIn: number) {
    let na = naIn, nb = nbIn;
    const basea = saIn;
    const tk = keys.slice(sbIn, sbIn + nb), tv = values ? values.slice(sbIn, sbIn + nb) : null;
    // pa, pb, dest are the last unmerged item of each run and the last free slot.
    let dest = sbIn + nb - 1, pa = saIn + na - 1, pb = nb - 1;
    const takeA = () => { keys[dest] = keys[pa]; if (values) values[dest] = values[pa]; dest--; pa--; };
    const takeB = () => { keys[dest] = tk[pb]; if (values) values[dest] = tv![pb]; dest--; pb--; };
    const flushB = () => { for (let i = 0; i < nb; i++) { keys[dest - nb + 1 + i] = tk[i]; if (values) values[dest - nb + 1 + i] = tv![i]; } };
    const copyA = () => {
      for (let i = 0; i < na; i++) { keys[dest - i] = keys[pa - i]; if (values) values[dest - i] = values[pa - i]; }
      dest -= na; pa -= na;
      keys[dest] = tk[pb];
      if (values) values[dest] = tv![pb];
    };

    takeA(); na--;
    if (na === 0) { flushB(); return; }
    if (nb === 1) { copyA(); return; }

    let mg = minGallop;
    for (;;) {
      let acount = 0, bcount = 0;
      for (;;) {
        if (lt(tk[pb], keys[pa])) {
          takeA(); acount++; bcount = 0; na--;
          if (na === 0) { flushB(); return; }
          if (acount >= mg) break;
        } else {
          takeB(); bcount++; acount = 0; nb--;
          if (nb === 1) { copyA(); return; }
          if (bcount >= mg) break;
        }
      }
      mg++;
      do {
        mg -= mg > 1 ? 1 : 0;
        minGallop = mg;
        let k = na - gallopRight(tk[pb], keys, basea, na, na - 1);
        acount = k;
        if (k) {
          for (let i = 0; i < k; i++) { keys[dest - i] = keys[pa - i]; if (values) values[dest - i] = values[pa - i]; }
          dest -= k; pa -= k; na -= k;
          if (na === 0) { flushB(); return; }
        }
        takeB(); nb--;
        if (nb === 1) { copyA(); return; }

        k = nb - gallopLeft(keys[pa], tk, 0, nb, nb - 1);
        bcount = k;
        if (k) {
          for (let i = 0; i < k; i++) { keys[dest - i] = tk[pb - i]; if (values) values[dest - i] = tv![pb - i]; }
          dest -= k; pb -= k; nb -= k;
          if (nb === 1) { copyA(); return; }
          // Impossible if the comparison is consistent, and it may not be.
          if (nb === 0) return;
        }
        takeA(); na--;
        if (na === 0) { flushB(); return; }
      } while (acount >= MIN_GALLOP || bcount >= MIN_GALLOP);
      mg++;
      minGallop = mg;
    }
  }

  function mergeAt(i: number) {
    let sa = pending[i].base, na = pending[i].len;
    const sb = pending[i + 1].base;
    let nb = pending[i + 1].len;
    pending[i].len = na + nb;
    pending.splice(i + 1, 1);

    const k = gallopRight(keys[sb], keys, sa, na, 0);
    sa += k; na -= k;
    if (na === 0) return;
    nb = gallopLeft(keys[sa + na - 1], keys, sb, nb, nb - 1);
    if (nb <= 0) return;
    if (na <= nb) mergeLo(sa, na, sb, nb); else mergeHi(sa, na, sb, nb);
  }

  function powerloop(s1: number, n1: number, n2: number, n: number): number {
    let result = 0, a = 2 * s1 + n1, b = a + n1 + n2;
    for (;;) {
      result++;
      if (a >= n) { a -= n; b -= n; } else if (b >= n) break;
      a *= 2; b *= 2;
    }
    return result;
  }

  function foundNewRun(n2: number) {
    if (!pending.length) return;
    const top = pending.at(-1)!;
    const power = powerloop(top.base, top.len, n2, total);
    while (pending.length > 1 && pending[pending.length - 2].power > power) mergeAt(pending.length - 2);
    pending.at(-1)!.power = power;
  }

  let minrun = total, r = 0;
  while (minrun >= 64) { r |= minrun & 1; minrun >>= 1; }
  minrun += r;

  let lo = 0, remaining = total;
  do {
    const run = countRun(lo, lo + remaining);
    let n = run.n;
    if (run.descending) {
      for (let i = lo, j = lo + n - 1; i < j; i++, j--) {
        [keys[i], keys[j]] = [keys[j], keys[i]];
        if (values) [values[i], values[j]] = [values[j], values[i]];
      }
    }
    if (n < minrun) {
      const force = remaining <= minrun ? remaining : minrun;
      binarysort(lo, lo + force, lo + n);
      n = force;
    }
    foundNewRun(n);
    pending.push({ base: lo, len: n, power: 0 });
    lo += n;
    remaining -= n;
  } while (remaining);

  while (pending.length > 1) {
    let n = pending.length - 2;
    if (n > 0 && pending[n - 1].len < pending[n + 1].len) n--;
    mergeAt(n);
  }

  if (reverse) { keys.reverse(); values?.reverse(); }
}
