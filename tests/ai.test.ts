// The AI lessons make claims a learner can check by playing; these make the
// same claims run in CI, so a refactor that breaks learning (a sign error in
// backprop still *runs*, and draws a plausible-looking blur) fails loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MLP, dataset, split, rng } from '../src/lib/nn/mlp.ts';
import { readFileSync } from 'node:fs';
import { trainBPE, encode, NGram, pretokenize, vocabulary, tokenId } from '../src/lib/tokens/bpe.ts';
import { KVSim, workload, kvBytesPerToken, formatBytes } from '../src/lib/kv/sim.ts';
import { CORPUS } from '../src/data/corpus.ts';

test('training lowers the loss and solves XOR with one hidden layer', () => {
  const { train, test: held } = split(dataset('xor', 300, 0.05));
  const net = new MLP(['x', 'y'], [6], 'tanh');
  const before = net.loss(train);
  for (let i = 0; i < 1500; i++) net.train(train, 0.5);
  assert.ok(net.loss(train) < before / 4, `loss ${before} -> ${net.loss(train)}`);
  assert.ok(net.accuracy(held) > 0.93, `held-out accuracy ${net.accuracy(held)}`);
});

test('without a hidden layer, XOR is out of reach - the reason hidden layers exist', () => {
  const { train } = split(dataset('xor', 300, 0.05));
  const net = new MLP(['x', 'y'], [], 'tanh');
  for (let i = 0; i < 1500; i++) net.train(train, 0.5);
  assert.ok(net.accuracy(train) < 0.8, `a straight line scored ${net.accuracy(train)}`);
});

test('the XOR network with no hidden layer stays far below solved (it settles near 57%, not 75%)', () => {
  // The lesson once said "around 75% at best" - the ceiling for *any* line -
  // and a `< 0.8` check let that pass while the widget showed 57%. Gradient
  // descent never finds the 75% line: it is confidently wrong on a whole
  // quarter, so cross-entropy prefers a nearly flat guess. Widget settings:
  // 360 points, noise 0.1, test accuracy, the learning rates on offer.
  const { train, test: held } = split(dataset('xor', 360, 0.1));
  for (const lr of [0.3, 1, 3]) for (const seed of [3, 4, 5]) {
    const net = new MLP(['x', 'y'], [], 'tanh', seed);
    for (let i = 0; i < 1500; i++) net.train(train, lr);
    assert.ok(net.accuracy(held) < 0.7, `lr ${lr} seed ${seed}: a straight line scored ${net.accuracy(held)} on held-out XOR`);
  }
});

test('...unless you hand it the right feature: x times y makes XOR linear', () => {
  const { train } = split(dataset('xor', 300, 0.05));
  const net = new MLP(['xy'], [], 'tanh');
  for (let i = 0; i < 800; i++) net.train(train, 1);
  assert.ok(net.accuracy(train) > 0.95, `xy feature scored ${net.accuracy(train)}`);
});

test('the gradient matches a numerical derivative', () => {
  // A wrong sign or a missing term still trains *something*. This catches it.
  const net = new MLP(['x', 'y'], [3], 'tanh', 11);
  const batch = dataset('circle', 20, 0.1, 5);
  const l = 0, k = 2, h = 1e-5;
  const orig = net.w[l][k];
  net.w[l][k] = orig + h; const up = net.loss(batch);
  net.w[l][k] = orig - h; const down = net.loss(batch);
  net.w[l][k] = orig;
  const numeric = (up - down) / (2 * h);
  const copy = Float64Array.from(net.w[l]);
  net.train(batch, 1);
  const analytic = copy[k] - net.w[l][k];
  assert.ok(Math.abs(numeric - analytic) < 1e-6, `numeric ${numeric} vs backprop ${analytic}`);
});

test('BPE round-trips and more merges mean fewer tokens', () => {
  const text = CORPUS.slice(0, 3000);
  let prev = Infinity;
  for (const m of [0, 20, 80, 200]) {
    const merges = trainBPE(text, m);
    const toks = encode(text, merges);
    assert.equal(toks.join(''), text, `round trip at ${m} merges`);
    assert.ok(toks.length <= prev, `${m} merges gave ${toks.length} tokens`);
    prev = toks.length;
  }
  assert.ok(prev < text.length / 2.5, `200 merges should compress well below characters: ${prev} vs ${text.length}`);
});

test('a leading space is part of the word', () => {
  assert.deepEqual(pretokenize('the panda saw the bamboo'), ['the', ' panda', ' saw', ' the', ' bamboo']);
});

test('the tokenizer slider ends where the story runs out of merges (about 340), not at a 400 it never reached', () => {
  // TokenLab's slider went to 400 and read "400 merges learned" while the last
  // sixty steps changed nothing: training stops once no pair occurs twice.
  const all = trainBPE(CORPUS, 400);
  assert.ok(all.length < 400, `story now yields ${all.length} merges - the slider max follows it`);
  assert.equal(trainBPE(CORPUS, 1000).length, all.length, 'asking for more finds no more');
  const src = readFileSync(new URL('../src/components/TokenLab.astro', import.meta.url), 'utf8');
  assert.match(src, /max=\{maxMerges\}/, 'the slider max must come from training, not a hard-coded number');
  assert.match(src, /const maxMerges = trainBPE\(CORPUS, 400\)\.length/);
});

test('token ids hold still when the learner types characters the story never used', () => {
  // TokenLab once numbered ids from story + typed text, so typing "1" moved
  // every letter's id up by one. A real vocabulary is fixed.
  const merges = trainBPE(CORPUS, 400);
  const ids = vocabulary(CORPUS, merges);
  const src = readFileSync(new URL('../src/components/TokenLab.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /vocabulary\(CORPUS \+/, 'ids must not be built from the learner\'s text');
  assert.match(src, /const IDS = vocabulary\(CORPUS, ALL\)/);
  // Fewer merges must not renumber anything either: ids are a prefix.
  const fewer = vocabulary(CORPUS, merges.slice(0, 50));
  for (const [t, n] of fewer) assert.equal(ids.get(t), n, `"${t}" renumbered by the slider`);
  assert.equal(tokenId(ids, ' panda'), ids.get(' panda'));
  // Unseen characters get ids of their own, past the end and never colliding.
  const unseen = ['1', '#', 'é', '🐼'].map((c) => tokenId(ids, c));
  assert.ok(unseen.every((n) => n >= ids.size), `unseen ids ${unseen} vs vocabulary ${ids.size}`);
  assert.equal(new Set(unseen).size, unseen.length);
});

test('temperature 0 is greedy, and probabilities always sum to 1', () => {
  const lm = new NGram(3, CORPUS);
  const d0 = lm.next('the ', 0, 10);
  assert.equal(d0[0].p, 1);
  for (const t of [0.3, 1, 2]) {
    const d = lm.next('the ', t, 10);
    assert.ok(Math.abs(d.reduce((s, x) => s + x.p, 0) - 1) < 1e-9);
  }
  const hot = lm.next('the ', 2, 10), cold = lm.next('the ', 0.3, 10);
  assert.ok(hot[0].p < cold[0].p, 'higher temperature flattens the distribution');
  const r = rng(1);
  assert.equal(typeof lm.sample('pan', 1, 5, r), 'string');
});

test('paged KV cache serves the same work in fewer steps with less waste', () => {
  const cfg = { blocks: 96, blockSize: 16, maxSeqLen: 512, maxBatch: 16 } as const;
  const reqs = workload(60, 3, cfg.maxSeqLen);
  const slab = new KVSim({ ...cfg, policy: 'contiguous', batching: 'continuous' }, reqs).runToEnd();
  const paged = new KVSim({ ...cfg, policy: 'paged', batching: 'continuous' }, reqs).runToEnd();
  assert.equal(slab.done.length, 60);
  assert.equal(paged.done.length, 60);
  const asked = reqs.reduce((n, r) => n + r.output, 0);
  assert.equal(slab.generatedTokens, asked);
  // Preemption is not free: an evicted request recomputes from scratch.
  assert.ok(paged.generatedTokens >= asked);
  assert.ok(paged.step < slab.step * 0.6, `paged ${paged.step} steps vs contiguous ${slab.step}`);
  const avgWaste = (s: KVSim) => s.history.reduce((n, h) => n + (h.reserved ? 1 - h.used / h.reserved : 0), 0) / s.history.length;
  assert.ok(avgWaste(slab) > 0.5, `contiguous wasted ${avgWaste(slab)}`);
  assert.ok(avgWaste(paged) < 0.2, `paged wasted ${avgWaste(paged)}`);
});

test('continuous batching never takes longer than static batching', () => {
  const cfg = { blocks: 400, blockSize: 16, maxSeqLen: 512, maxBatch: 8, policy: 'paged' } as const;
  const reqs = workload(40, 9, cfg.maxSeqLen);
  const stat = new KVSim({ ...cfg, batching: 'static' }, reqs).runToEnd();
  const cont = new KVSim({ ...cfg, batching: 'continuous' }, reqs).runToEnd();
  assert.ok(cont.step < stat.step, `continuous ${cont.step} vs static ${stat.step}`);
  assert.ok(cont.idleSlotSteps < stat.idleSlotSteps);
});

test('KV cache size: Llama-2-7B is half a mebibyte per token in fp16', () => {
  // 32 layers x 32 KV heads x 128 dims x K and V x 2 bytes. Grouped-query
  // attention (8 KV heads, as in Llama 3 8B) cuts it by four.
  assert.equal(kvBytesPerToken(32, 32, 128, 2), 512 * 1024);
  assert.equal(kvBytesPerToken(32, 8, 128, 2), 128 * 1024);
});

test('KV calculator: fp16 and fp8 per-token sizes read differently (both once showed "0.1 MiB")', () => {
  assert.equal(formatBytes(kvBytesPerToken(32, 8, 128, 2)), '128 KiB');
  assert.equal(formatBytes(kvBytesPerToken(32, 8, 128, 1)), '64 KiB');
  assert.equal(formatBytes(kvBytesPerToken(32, 32, 128, 1)), '256 KiB');
  assert.equal(formatBytes(kvBytesPerToken(32, 8, 128, 2) * 8192 * 32), '32.0 GiB');
  assert.equal(formatBytes(3 * 2 ** 20), '3.0 MiB');
});
