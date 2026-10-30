// Every NeuralPlayground challenge a lesson points at must be winnable with
// settings the widget offers, at the widget's own sizes (360 points, 30% held
// out, seed 3 network). A challenge nobody can pass reads as the learner's
// failure. Each test is one known-winning recipe; lessons hint toward it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MLP, dataset, split, type DatasetName, type FeatureName } from '../src/lib/nn/mlp.ts';

function play(ds: DatasetName, noise: number, feats: FeatureName[], hidden: number[], lr: number, epochs: number, act: 'tanh' | 'relu' = 'tanh') {
  const data = split(dataset(ds, 360, noise));
  const net = new MLP(feats, hidden, act, 3);
  let best = 0;
  for (let e = 1; e <= epochs; e++) {
    net.train(data.train, lr);
    // The widget awards the moment test accuracy crosses the line, so the
    // best value seen during training is what a learner can actually win with.
    if (e % 10 === 0) best = Math.max(best, net.accuracy(data.test));
  }
  return { best, knobs: net.parameterCount, net, data };
}

test('nn-ring: 95% with the default 4-neuron layer', () => {
  const r = play('circle', 0.1, ['x', 'y'], [4], 0.3, 1500);
  assert.ok(r.best >= 0.95, `best ${r.best}`);
});

test('nn-xor-lean: 95% with no hidden layer, given the xy input', () => {
  const r = play('xor', 0.1, ['xy'], [], 1, 1500);
  assert.ok(r.best >= 0.95, `best ${r.best}`);
});

test('nn-spiral: 90% with two hidden layers and the sine inputs', () => {
  const r = play('spiral', 0.1, ['x', 'y', 'sin x', 'sin y'], [8, 8], 0.3, 3000);
  assert.ok(r.best >= 0.9, `best ${r.best}`);
});

test('nn-spiral-tiny: 85% within 60 knobs', () => {
  // 4 inputs -> 5 -> 4 -> 1 is 54 knobs. (6,4 is 63: count before you claim.)
  const r = play('spiral', 0.1, ['x', 'y', 'sin x', 'sin y'], [5, 4], 0.3, 4000);
  assert.ok(r.knobs <= 60, `knobs ${r.knobs}`);
  assert.ok(r.best >= 0.85, `best ${r.best}`);
});

test('the overfitting lesson recipe really overfits: train loss collapses, test accuracy falls', () => {
  // ml/overfitting tells learners to do exactly this and watch. Measured when
  // written: train loss 0.34 -> 0.03, test accuracy 83% -> 72%.
  const data = split(dataset('circle', 360, 0.5));
  const net = new MLP(['x', 'y', 'x²', 'y²', 'xy', 'sin x', 'sin y'], [12, 12], 'tanh', 3);
  let early = 0, earlyLoss = 0;
  for (let e = 1; e <= 8000; e++) {
    net.train(data.train, 1);
    if (e === 300) { early = net.accuracy(data.test); earlyLoss = net.loss(data.train); }
  }
  assert.ok(net.loss(data.train) < earlyLoss / 5, `train loss ${earlyLoss} -> ${net.loss(data.train)}`);
  assert.ok(net.accuracy(data.test) < early - 0.05, `test accuracy ${early} -> ${net.accuracy(data.test)}`);
});

test('learning-rate lesson: 0.03 crawls, 3 is fast here, 10 overshoots', () => {
  // ml/what-is-learning describes these three outcomes on the ring. An earlier
  // draft said 3 overshoots - measured, it does not on this problem; 10 does.
  const data = split(dataset('circle', 360, 0.1));
  const lossAfter = (lr: number) => { const n = new MLP(['x', 'y'], [4], 'tanh', 3); for (let e = 0; e < 300; e++) n.train(data.train, lr); return n.loss(data.train); };
  const crawl = lossAfter(0.03), fast = lossAfter(3), wild = lossAfter(10);
  assert.ok(crawl > 0.6, `0.03 should barely move from ~0.69: ${crawl}`);
  assert.ok(fast < 0.1, `3 should be fast on the ring: ${fast}`);
  assert.ok(wild > fast * 5, `10 should end far worse than 3: ${wild} vs ${fast}`);
});

test('learning-rate lesson: 0.03 creeps at first but does learn the ring within seconds', () => {
  // The widget runs 8 steps a frame, roughly 400-480 a second. An earlier draft
  // said 0.03 "barely changes in the time you'd wait"; measured, it was past
  // 85% test accuracy within about 2,000 steps. The lesson now says it creeps
  // for the first few seconds - this pins both halves of that.
  const data = split(dataset('circle', 360, 0.1));
  const net = new MLP(['x', 'y'], [4], 'tanh', 3);
  for (let e = 0; e < 1000; e++) net.train(data.train, 0.03);
  assert.ok(net.loss(data.train) > 0.6, `still creeping after ~2 s: ${net.loss(data.train)}`);
  for (let e = 0; e < 4000; e++) net.train(data.train, 0.03);
  assert.ok(net.accuracy(data.test) >= 0.9, `learned within ~10 s: ${net.accuracy(data.test)}`);
});

test('nn-noisy-ring: 85% on held-out points with noise at 0.3', () => {
  const r = play('circle', 0.3, ['x', 'y'], [4], 0.3, 1500);
  assert.ok(r.best >= 0.85, `best ${r.best}`);
});

test('nn-noisy-ring is won by the big 265-knob network too, within a few hundred steps', () => {
  // ml/overfitting once said big networks "tend to lose this one". Measured,
  // they cross 85% within about 20 steps (x² and y² make the ring a straight
  // split) - the award fires before any memorising starts. What a big network
  // does is slide afterwards, which is what the lesson now says.
  const r = play('circle', 0.3, ['x', 'y', 'x²', 'y²', 'xy', 'sin x', 'sin y'], [12, 12], 0.3, 300);
  assert.equal(r.knobs, 265);
  assert.ok(r.best >= 0.85, `best ${r.best}`);
});
