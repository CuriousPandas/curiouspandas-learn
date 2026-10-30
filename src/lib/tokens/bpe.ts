// Byte-pair encoding the way GPT-style tokenizers learn it: start from single
// characters, repeatedly glue together the most frequent neighbouring pair, and
// remember the order of the glue. Text is first cut into words with their
// leading space, so " the" and "the" become different tokens - which is why a
// model can treat the same word differently at the start of a sentence.

export type Merge = [string, string];

export function pretokenize(text: string): string[] {
  return text.match(/ ?[A-Za-z]+| ?[0-9]+| ?[^A-Za-z0-9\s]+|\s+(?!\S)|\s+/g) ?? [];
}

export function trainBPE(text: string, merges: number): Merge[] {
  const words = new Map<string, number>();
  for (const w of pretokenize(text)) words.set(w, (words.get(w) ?? 0) + 1);
  let split = [...words].map(([w, n]) => ({ parts: [...w], n }));
  const out: Merge[] = [];
  for (let m = 0; m < merges; m++) {
    const pairs = new Map<string, number>();
    for (const { parts, n } of split) {
      for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i] + '\u0000' + parts[i + 1];
        pairs.set(k, (pairs.get(k) ?? 0) + n);
      }
    }
    let best = '', bestN = 1;
    // Ties break on the pair itself so training is deterministic; otherwise two
    // learners with the same text would see different vocabularies.
    for (const [k, n] of pairs) if (n > bestN || (n === bestN && best && k < best)) { best = k; bestN = n; }
    if (!best) break;
    const [a, b] = best.split('\u0000') as Merge;
    out.push([a, b]);
    split = split.map(({ parts, n }) => {
      const next: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) { next.push(a + b); i++; }
        else next.push(parts[i]);
      }
      return { parts: next, n };
    });
  }
  return out;
}

export function encode(text: string, merges: Merge[]): string[] {
  const rank = new Map(merges.map(([a, b], i) => [a + '\u0000' + b, i]));
  const tokens: string[] = [];
  for (const w of pretokenize(text)) {
    let parts = [...w];
    while (parts.length > 1) {
      let bestI = -1, bestR = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = rank.get(parts[i] + '\u0000' + parts[i + 1]);
        if (r !== undefined && r < bestR) { bestR = r; bestI = i; }
      }
      if (bestI < 0) break;
      parts = [...parts.slice(0, bestI), parts[bestI] + parts[bestI + 1], ...parts.slice(bestI + 2)];
    }
    tokens.push(...parts);
  }
  return tokens;
}

/** Stable small integer ids, the way a real vocabulary numbers its entries. */
export function vocabulary(text: string, merges: Merge[]): Map<string, number> {
  const v = new Map<string, number>();
  for (const ch of [...new Set([...text])].sort()) v.set(ch, v.size);
  for (const [a, b] of merges) if (!v.has(a + b)) v.set(a + b, v.size);
  return v;
}

/**
 * The id for a token, including a character the training text never used.
 * Real tokenizers start from all 256 bytes, so nothing is ever unknown. This toy
 * starts from the story's characters, so an unseen one is numbered past the end
 * of the vocabulary by its code point. Building the vocabulary from the
 * learner's text instead made every id shift as they typed: one "1" moved every
 * letter's id up by one, which no real vocabulary does.
 */
export function tokenId(vocab: Map<string, number>, token: string): number {
  return vocab.get(token) ?? vocab.size + token.codePointAt(0)!;
}

// ---- next-token prediction ----------------------------------------------

/**
 * A character n-gram model: the "context window" is the last `order` characters.
 * It is a toy, but it has the same interface as an LLM - context in, probability
 * for every possible next token out - and the same knobs: temperature and top-k.
 */
export class NGram {
  counts = new Map<string, Map<string, number>>();
  order: number;
  constructor(order: number, corpus: string) {
    this.order = order;
    for (let i = 0; i < corpus.length; i++) {
      for (let k = 0; k <= order; k++) {
        if (i - k < 0) break;
        const ctx = corpus.slice(i - k, i);
        let m = this.counts.get(ctx);
        if (!m) this.counts.set(ctx, (m = new Map()));
        m.set(corpus[i], (m.get(corpus[i]) ?? 0) + 1);
      }
    }
  }

  /** Back off to a shorter context when this one was never seen, as early n-gram models did. */
  next(context: string, temperature: number, topK: number): { token: string; p: number }[] {
    let m: Map<string, number> | undefined;
    for (let k = Math.min(this.order, context.length); k >= 0 && !m; k--) m = this.counts.get(context.slice(context.length - k));
    const entries = [...(m ?? new Map())].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, Math.max(1, topK));
    if (temperature <= 0.001) return entries.map(([t], i) => ({ token: t, p: i === 0 ? 1 : 0 }));
    const logits = entries.map(([, n]) => Math.log(n) / temperature);
    const max = Math.max(...logits);
    const exp = logits.map((l) => Math.exp(l - max));
    const z = exp.reduce((a, b) => a + b, 0);
    return entries.map(([t], i) => ({ token: t, p: exp[i] / z }));
  }

  sample(context: string, temperature: number, topK: number, rand: () => number): string {
    const dist = this.next(context, temperature, topK);
    let r = rand();
    for (const d of dist) { r -= d.p; if (r <= 0) return d.token; }
    return dist[dist.length - 1]?.token ?? ' ';
  }
}
