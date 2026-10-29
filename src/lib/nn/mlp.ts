// A neural network small enough to read: dense layers, tanh or ReLU, a sigmoid
// output, binary cross-entropy, plain gradient descent. No library, because the
// lesson is that there is no magic in here - and a library would put 300 kB of
// it between the learner and the twenty lines that do the learning.

export type Point = { x: number; y: number; label: 0 | 1 };
export type DatasetName = 'blobs' | 'circle' | 'xor' | 'spiral';
export type Activation = 'tanh' | 'relu';
export type FeatureName = 'x' | 'y' | 'x²' | 'y²' | 'xy' | 'sin x' | 'sin y';

export const FEATURES: Record<FeatureName, (x: number, y: number) => number> = {
  x: (x) => x, y: (_, y) => y, 'x²': (x) => x * x, 'y²': (_, y) => y * y, xy: (x, y) => x * y,
  'sin x': (x) => Math.sin(Math.PI * x), 'sin y': (_, y) => Math.sin(Math.PI * y),
};

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dataset(name: DatasetName, n: number, noise: number, seed = 1): Point[] {
  const r = rng(seed);
  const g = () => (r() + r() + r() - 1.5) * noise;
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const label = (i % 2) as 0 | 1;
    let x = 0, y = 0;
    if (name === 'blobs') { const c = label ? 0.45 : -0.45; x = c + g() + (r() - 0.5) * 0.4; y = c + g() + (r() - 0.5) * 0.4; }
    else if (name === 'circle') {
      const rad = label ? r() * 0.38 : 0.6 + r() * 0.3, a = r() * Math.PI * 2;
      x = Math.cos(a) * rad + g(); y = Math.sin(a) * rad + g();
    } else if (name === 'xor') {
      x = (r() * 2 - 1) * 0.9; y = (r() * 2 - 1) * 0.9;
      if (Math.abs(x) < 0.06) x += 0.12 * Math.sign(x || 1);
      if (Math.abs(y) < 0.06) y += 0.12 * Math.sign(y || 1);
      pts.push({ x: x + g(), y: y + g(), label: (x * y > 0 ? 1 : 0) as 0 | 1 });
      continue;
    } else {
      // Two arms, one and a half turns each, the second rotated half a turn.
      const t = Math.floor(i / 2) / (n / 2);
      const a = t * 3 * Math.PI + (label ? Math.PI : 0);
      const rad = 0.08 + t * 0.85;
      x = rad * Math.sin(a) + g(); y = rad * Math.cos(a) + g();
    }
    pts.push({ x, y, label });
  }
  return pts;
}

export function split(points: Point[], testFraction = 0.3, seed = 7) {
  const r = rng(seed);
  const shuffled = [...points].sort(() => r() - 0.5);
  const cut = Math.floor(points.length * (1 - testFraction));
  return { train: shuffled.slice(0, cut), test: shuffled.slice(cut) };
}

export class MLP {
  sizes: number[];
  w: Float64Array[];
  b: Float64Array[];
  activation: Activation;
  features: FeatureName[];

  constructor(features: FeatureName[], hidden: number[], activation: Activation = 'tanh', seed = 3) {
    this.features = features;
    this.activation = activation;
    this.sizes = [features.length, ...hidden, 1];
    const r = rng(seed);
    this.w = []; this.b = [];
    for (let l = 0; l < this.sizes.length - 1; l++) {
      const fanIn = this.sizes[l], out = this.sizes[l + 1];
      // Xavier-style scale: with all-equal or too-large starting weights every
      // neuron learns the same thing, or tanh saturates and nothing learns.
      const scale = Math.sqrt(2 / (fanIn + out));
      this.w.push(Float64Array.from({ length: fanIn * out }, () => (r() * 2 - 1) * scale * 1.7));
      this.b.push(new Float64Array(out));
    }
  }

  get parameterCount() { return this.w.reduce((n, w) => n + w.length, 0) + this.b.reduce((n, b) => n + b.length, 0); }

  input(x: number, y: number) { return this.features.map((f) => FEATURES[f](x, y)); }

  private act(z: number) { return this.activation === 'tanh' ? Math.tanh(z) : Math.max(0, z); }
  private dact(a: number, z: number) { return this.activation === 'tanh' ? 1 - a * a : z > 0 ? 1 : 0; }

  /** Activations for every layer; the last is the probability of label 1. */
  forward(x: number, y: number) {
    const as: number[][] = [this.input(x, y)];
    const zs: number[][] = [];
    for (let l = 0; l < this.w.length; l++) {
      const prev = as[l], n = this.sizes[l + 1], z = new Array(n), a = new Array(n);
      for (let j = 0; j < n; j++) {
        let s = this.b[l][j];
        for (let i = 0; i < prev.length; i++) s += prev[i] * this.w[l][j * prev.length + i];
        z[j] = s;
        a[j] = l === this.w.length - 1 ? 1 / (1 + Math.exp(-s)) : this.act(s);
      }
      zs.push(z); as.push(a);
    }
    return { as, zs };
  }

  predict(x: number, y: number) { const { as } = this.forward(x, y); return as[as.length - 1][0]; }

  /** One pass of gradient descent over the batch; returns the mean loss before the update. */
  train(batch: Point[], lr: number, l2 = 0) {
    const gw = this.w.map((w) => new Float64Array(w.length));
    const gb = this.b.map((b) => new Float64Array(b.length));
    let loss = 0;
    for (const p of batch) {
      const { as, zs } = this.forward(p.x, p.y);
      const out = as[as.length - 1][0];
      const eps = 1e-9;
      loss += -(p.label * Math.log(out + eps) + (1 - p.label) * Math.log(1 - out + eps));
      // Sigmoid + cross-entropy differentiate to (prediction - truth). That
      // cancellation is why the pair is the default for yes/no outputs.
      let delta = [out - p.label];
      for (let l = this.w.length - 1; l >= 0; l--) {
        const prev = as[l];
        for (let j = 0; j < delta.length; j++) {
          gb[l][j] += delta[j];
          for (let i = 0; i < prev.length; i++) gw[l][j * prev.length + i] += delta[j] * prev[i];
        }
        if (l === 0) break;
        const next = new Array(prev.length).fill(0);
        for (let i = 0; i < prev.length; i++) {
          let s = 0;
          for (let j = 0; j < delta.length; j++) s += delta[j] * this.w[l][j * prev.length + i];
          next[i] = s * this.dact(prev[i], zs[l - 1][i]);
        }
        delta = next;
      }
    }
    const n = batch.length || 1;
    for (let l = 0; l < this.w.length; l++) {
      for (let k = 0; k < this.w[l].length; k++) this.w[l][k] -= lr * (gw[l][k] / n + l2 * this.w[l][k]);
      for (let k = 0; k < this.b[l].length; k++) this.b[l][k] -= lr * (gb[l][k] / n);
    }
    return loss / n;
  }

  loss(points: Point[]) {
    let s = 0;
    for (const p of points) { const o = this.predict(p.x, p.y); s += -(p.label * Math.log(o + 1e-9) + (1 - p.label) * Math.log(1 - o + 1e-9)); }
    return s / (points.length || 1);
  }

  accuracy(points: Point[]) {
    if (!points.length) return 0;
    return points.filter((p) => (this.predict(p.x, p.y) >= 0.5 ? 1 : 0) === p.label).length / points.length;
  }
}
