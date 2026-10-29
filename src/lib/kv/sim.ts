// Why vLLM is fast, as a simulation you can watch. Two ideas from the vLLM
// paper (Kwon et al., SOSP 2023, arXiv:2309.06180):
//
//  1. PagedAttention - the KV cache is cut into fixed-size blocks handed out on
//     demand, like virtual-memory pages, instead of one contiguous slab reserved
//     per request for the longest answer it might give.
//  2. Continuous batching - a finished request's slot is refilled on the very
//     next step, instead of the whole batch waiting for its slowest member.
//
// The model is deliberately crude (one decode token per step, prefill takes one
// step). What it must get right is the *accounting*: reserved vs. actually
// used memory, and idle slots. tests/kv.test.ts pins those.

import { rng } from '../nn/mlp.ts';

export type Policy = 'contiguous' | 'paged';
export type Batching = 'static' | 'continuous';
export type Request = { id: number; prompt: number; output: number; generated: number; prefilled: boolean; blocks: number[]; admittedAt?: number; finishedAt?: number; preemptions: number };

export type SimConfig = { blocks: number; blockSize: number; maxSeqLen: number; maxBatch: number; policy: Policy; batching: Batching };

export function workload(n: number, seed: number, maxSeqLen: number): Request[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, id) => {
    const prompt = 8 + Math.floor(r() * 56);
    // Output length is long-tailed and unknown in advance - the whole reason
    // reserving for the maximum wastes so much.
    const output = Math.min(maxSeqLen - prompt, 4 + Math.floor(Math.pow(r(), 2.2) * (maxSeqLen - prompt)));
    return { id, prompt, output, generated: 0, prefilled: false, blocks: [], preemptions: 0 };
  });
}

export class KVSim {
  step = 0;
  free: boolean[];
  owner: (number | null)[];
  waiting: Request[];
  running: Request[] = [];
  done: Request[] = [];
  generatedTokens = 0;
  idleSlotSteps = 0;
  history: { step: number; used: number; reserved: number; running: number }[] = [];

  cfg: SimConfig;

  constructor(cfg: SimConfig, requests: Request[]) {
    this.cfg = cfg;
    this.free = new Array(cfg.blocks).fill(true);
    this.owner = new Array(cfg.blocks).fill(null);
    this.waiting = requests.map((r) => ({ ...r, blocks: [] }));
  }

  get finished() { return this.waiting.length === 0 && this.running.length === 0; }

  tokensHeld(r: Request) { return r.prefilled ? r.prompt + r.generated : 0; }

  stats() {
    const reserved = this.owner.filter((o) => o !== null).length * this.cfg.blockSize;
    const used = this.running.reduce((n, r) => n + this.tokensHeld(r), 0);
    return { used, reserved, capacity: this.cfg.blocks * this.cfg.blockSize, waste: reserved ? 1 - used / reserved : 0 };
  }

  private blocksFor(tokens: number) { return Math.ceil(tokens / this.cfg.blockSize); }

  private allocate(r: Request, count: number, contiguous: boolean): boolean {
    let picked: number[] = [];
    if (contiguous) {
      // A slab must be one unbroken run. Free space split into holes too small
      // to hold it is unusable: external fragmentation.
      for (let i = 0, run = 0; i < this.free.length; i++) {
        run = this.free[i] ? run + 1 : 0;
        if (run === count) { picked = Array.from({ length: count }, (_, k) => i - count + 1 + k); break; }
      }
    } else {
      for (let i = 0; i < this.free.length && picked.length < count; i++) if (this.free[i]) picked.push(i);
      if (picked.length < count) picked = [];
    }
    if (picked.length < count) return false;
    for (const b of picked) { this.free[b] = false; this.owner[b] = r.id; }
    r.blocks.push(...picked);
    return true;
  }

  private release(r: Request) {
    for (const b of r.blocks) { this.free[b] = true; this.owner[b] = null; }
    r.blocks = [];
  }

  private admit() {
    if (this.cfg.batching === 'static' && this.running.length) return;
    while (this.waiting.length && this.running.length < this.cfg.maxBatch) {
      const r = this.waiting[0];
      const need = this.cfg.policy === 'contiguous' ? this.blocksFor(this.cfg.maxSeqLen) : this.blocksFor(r.prompt + 1);
      if (!this.allocate(r, need, this.cfg.policy === 'contiguous')) break;
      this.waiting.shift();
      r.admittedAt ??= this.step;
      this.running.push(r);
    }
  }

  tick() {
    if (this.finished) return;
    this.step++;
    this.admit();
    for (const r of [...this.running]) {
      if (!this.running.includes(r)) continue;
      if (!r.prefilled) { r.prefilled = true; continue; }
      if (this.cfg.policy === 'paged' && this.tokensHeld(r) + 1 > r.blocks.length * this.cfg.blockSize) {
        if (!this.allocate(r, 1, false)) {
          // Out of blocks mid-answer: evict the newest request and recompute it
          // later - the trade vLLM makes rather than refusing to admit work.
          const victim = this.running[this.running.length - 1];
          this.release(victim);
          this.running.pop();
          victim.prefilled = false; victim.generated = 0; victim.preemptions++;
          this.waiting.unshift(victim);
          if (victim === r || !this.allocate(r, 1, false)) continue;
        }
      }
      r.generated++;
      this.generatedTokens++;
      if (r.generated >= r.output) {
        r.finishedAt = this.step;
        this.release(r);
        this.running.splice(this.running.indexOf(r), 1);
        this.done.push(r);
      }
    }
    this.idleSlotSteps += this.cfg.maxBatch - this.running.length;
    const s = this.stats();
    this.history.push({ step: this.step, used: s.used, reserved: s.reserved, running: this.running.length });
    if (this.history.length > 400) this.history.shift();
  }

  runToEnd(limit = 100000) { while (!this.finished && this.step < limit) this.tick(); return this; }
}

/** KV cache bytes per token: keys and values, for every layer and KV head. */
export function kvBytesPerToken(layers: number, kvHeads: number, headDim: number, bytesPerValue: number) {
  return 2 * layers * kvHeads * headDim * bytesPerValue;
}
