// Attention as it is actually computed - scaled dot products, a causal mask,
// a softmax - but over vectors set by hand instead of learned. Real models
// learn thousands of dimensions nobody can name; these have four that can be
// named (animal, food, action, filler), so a learner can see *why* a weight is
// high. The arithmetic is the real arithmetic; only the numbers are invented.

export const FEATURES = ['animal', 'food', 'action', 'filler'] as const;
export type Vec = [number, number, number, number];
export type Token = { text: string; key: Vec; query: Vec };

const W: Record<string, { key: Vec; query: Vec }> = {
  the: { key: [0, 0, 0, 1], query: [0, 0, 0, 1] },
  panda: { key: [3, 0, 0, 0], query: [0, 0, 1, 0] },
  ate: { key: [0, 0, 3, 0], query: [2, 0, 0, 0] },
  bamboo: { key: [0, 3, 0, 0], query: [0, 0, 1, 0] },
  because: { key: [0, 0, 0, 1], query: [0, 0, 1, 0] },
  // "it" asks for a noun, and both nouns answer equally: at this point in the
  // sentence the model genuinely cannot know which one is meant.
  it: { key: [0, 0, 0, 1], query: [1, 1, 0, 0] },
  was: { key: [0, 0, 0, 1], query: [0, 0, 0, 1] },
  hungry: { key: [0, 0, 1, 0], query: [2, 0, 0, 0] },
  tasty: { key: [0, 0, 0, 0], query: [0, 2, 0, 0] },
};

export const SENTENCES = {
  hungry: 'the panda ate the bamboo because it was hungry',
  tasty: 'the panda ate the bamboo because it was tasty',
} as const;

export function tokens(sentence: string): Token[] {
  return sentence.split(' ').map((text) => {
    const w = W[text];
    if (!w) throw new Error(`no hand-set vectors for "${text}"`);
    return { text, ...w };
  });
}

const dot = (a: Vec, b: Vec) => a.reduce((s, x, i) => s + x * b[i], 0);

export function softmax(xs: number[]): number[] {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const z = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / z);
}

/**
 * Row i of the attention matrix: how much token i draws from each token j.
 * Causal, like GPT-style models: a token sees itself and what came before,
 * never what comes after, so entries for j > i are exactly 0.
 * `sharpness` multiplies the scores - the same effect as a smaller temperature.
 */
export function attentionRow(toks: Token[], i: number, sharpness = 1): number[] {
  const d = toks[0].key.length;
  const scores = toks.slice(0, i + 1).map((t) => (dot(toks[i].query, t.key) / Math.sqrt(d)) * sharpness);
  const w = softmax(scores);
  return toks.map((_, j) => (j <= i ? w[j] : 0));
}

export function attentionMatrix(toks: Token[], sharpness = 1): number[][] {
  return toks.map((_, i) => attentionRow(toks, i, sharpness));
}
