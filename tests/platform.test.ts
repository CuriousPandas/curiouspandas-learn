// Pins what the platform lessons say about reconcilers and scrape targets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitOps } from '../src/lib/gitops/sim.ts';
import { targets, kubernetesView, Scraper, HELLO } from '../src/lib/obs/scrape.ts';

test('a Kustomization puts a kubectl edit back within one interval', () => {
  const g = new GitOps({ mode: 'kustomize', interval: 5 });
  g.kubectlEdit({ replicas: 7 });
  g.step(5);
  assert.equal(g.live.replicas, 2);
  assert.equal(g.corrected, 1);
});

test('a HelmRelease without drift detection leaves the edit alone until git changes', () => {
  const g = new GitOps({ mode: 'helm', interval: 5 });
  g.kubectlEdit({ replicas: 7 });
  g.step(50);
  assert.equal(g.live.replicas, 7, 'nothing compares live objects with the chart');
  g.commit({ image: 'panda/hello:2.0' }, 'v2');
  g.step(5);
  assert.equal(g.live.replicas, 2, 'the next upgrade re-renders and overwrites it as a side effect');
  assert.equal(g.live.image, 'panda/hello:2.0');
});

test('manual apply: nothing happens until someone runs it', () => {
  const g = new GitOps({ mode: 'manual' });
  g.commit({ replicas: 4 }, 'scale');
  g.step(100);
  assert.equal(g.live.replicas, 2);
  g.applyByHand();
  assert.equal(g.live.replicas, 4);
});

test('prune deletes what git dropped; without prune it is orphaned', () => {
  const on = new GitOps({ mode: 'kustomize', interval: 3, prune: true });
  on.commit({ banner: false }, 'drop banner');
  on.step(3);
  assert.equal(on.live.banner, false);
  assert.equal(on.pruned, 1);
  const off = new GitOps({ mode: 'kustomize', interval: 3, prune: false });
  off.commit({ banner: false }, 'drop banner');
  off.step(9);
  assert.equal(off.live.banner, true, 'still running, owned by nobody');
});

test('a ServiceMonitor naming the wrong port finds no target, and Kubernetes is content', () => {
  assert.equal(targets([HELLO], { selectorKey: 'app.kubernetes.io/name', selectorValue: 'hello', port: 'http' }).length, 1);
  const broken = { selectorKey: 'app.kubernetes.io/name', selectorValue: 'hello', port: 'metrics' };
  assert.equal(targets([HELLO], broken).length, 0);
  assert.deepEqual(kubernetesView(broken), { servicemonitorExists: true, events: 0, podsReady: '1/1' });
});

test('a selector on the old label finds no Service - the Loki story', () => {
  assert.equal(targets([HELLO], { selectorKey: 'app', selectorValue: 'hello', port: 'http' }).length, 0);
});

test('the panel has data only while a target is being scraped', () => {
  const s = new Scraper({ selectorKey: 'app.kubernetes.io/name', selectorValue: 'hello', port: 'http' });
  s.step(10);
  assert.ok(s.panel().length > 0);
  s.sm = { ...s.sm, port: 'metrics' };
  s.step(10);
  assert.equal(s.panel().length, 0);
  assert.equal(s.lastScrape, 10, 'the last scrape stays where it was: freshness is the tell');
});
