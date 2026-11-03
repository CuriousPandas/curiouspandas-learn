// Every workloads mission, played from its own hints the way a learner would,
// and judged the way the panel judges it: in order, all at once at the end. A
// step that a later step quietly un-ticks makes a mission impossible to
// finish, and that cost 60 XP nobody could earn on the programming track
// (tests/prog-missions-finish.test.ts). The second half plays the tempting
// shortcuts that would also turn the cluster green, and checks they don't pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { KUBE_A_MISSIONS, kubeRun } from '../src/lib/kube/missions.ts';
import { KUBE_MISSIONS, type KubeState } from '../src/lib/missions.ts';
import { key } from '../src/lib/kube/cluster.ts';

const commands = (hint: string) => hint.split(/\s{2}(?:then|or)\s{2}/).map((c) => c.trim());
const ticks = (steps: { done: (s: KubeState) => boolean }[], s: KubeState) => { let n = 0; for (const st of steps) { if (!st.done(s)) break; n++; } return n; };

function play(s: KubeState, cmd: string) {
  const out = kubeRun(s, cmd);
  const errs = out.filter((l) => l.kind === 'err');
  assert.deepEqual(errs, [], `"${cmd}" errored`);
  return out.map((l) => l.text).join('\n');
}

const until = (s: KubeState, ok: () => boolean, limit = 80) => { for (let i = 0; i < limit && !ok(); i++) s.cluster.step(); return ok(); };

// The lessons are where missions are used; read them so a new one cannot be left out.
const LESSONS = join(import.meta.dirname, '..', 'src', 'content', 'lessons', 'kubernetes');
const used = readdirSync(LESSONS).flatMap((f) => [...readFileSync(join(LESSONS, f), 'utf8').matchAll(/<KubeSim mission="([^"]+)"/g)].map((m) => m[1]));

test('every KubeSim mission a lesson names exists', () => {
  for (const id of used) assert.ok(KUBE_MISSIONS[id] || KUBE_A_MISSIONS[id], `no mission ${id}`);
  for (const id of Object.keys(KUBE_A_MISSIONS)) assert.ok(used.includes(id), `${id} is defined but no lesson uses it`);
});

test('the new mission ids do not collide with the first five', () => {
  for (const id of Object.keys(KUBE_A_MISSIONS)) assert.equal(KUBE_MISSIONS[id], undefined, id);
});

for (const m of Object.values(KUBE_A_MISSIONS)) {
  test(`kube mission "${m.id}" is completable from its hints, and stays complete`, () => {
    const s = m.setup();
    assert.equal(ticks(m.steps, s), 0, 'no step is born done');
    let best = 0;
    for (const [i, step] of m.steps.entries()) {
      for (const cmd of commands(step.hint ?? '')) play(s, cmd);
      assert.ok(until(s, () => step.done(s)), `step ${i + 1} "${step.text}" not done within 80 ticks of its hint`);
      const n = ticks(m.steps, s);
      assert.ok(n >= best, `step ${i + 1} un-ticked an earlier step (${best} -> ${n})`);
      best = n;
    }
    for (let i = 0; i < 30; i++) s.cluster.step();
    assert.equal(ticks(m.steps, s), m.steps.length, 'every step still ticked 30 ticks after the end');
  });
}

// ---- shortcuts that must not pass ---------------------------------------

const fresh = (id: string) => KUBE_A_MISSIONS[id].setup();
const step = (id: string, n: number) => KUBE_A_MISSIONS[id].steps[n - 1];

test('namespaces: making a pod in default does not count as finding the shop app', () => {
  const s = fresh('kube-namespaces');
  play(s, 'kubectl create deployment hello --image=panda/hello:1.0');
  s.cluster.step(4);
  play(s, 'kubectl get pods');
  assert.equal(step('kube-namespaces', 1).done(s), false, 'default is no longer empty: this is not the "nothing here" moment');
  assert.equal(step('kube-namespaces', 2).done(s), false);
});

test('namespaces: a typo in set-context leaves every command looking at an empty namespace, with no error', () => {
  const s = fresh('kube-namespaces');
  assert.equal(play(s, 'kubectl config set-context --current --namespace=shpo'), 'Context "kind-sandbox" modified.');
  assert.equal(play(s, 'kubectl get pods'), 'No resources found in shpo namespace.');
  assert.equal(step('kube-namespaces', 4).done(s), false);
});

test('config: putting the password straight into the Deployment does not pass', () => {
  const s = fresh('kube-config');
  play(s, 'kubectl set env deployment/api DATABASE_URL=postgres://db:5432/shop');
  until(s, () => (s.cluster.deploymentStatus('api').ready ?? 0) >= 1);
  assert.equal(s.cluster.deploymentStatus('api').ready, 1, 'api runs');
  assert.equal(step('kube-config', 5).done(s), false, 'but the secret is in plain text in the Deployment');
});

test('config: looking at the logs before changing the ConfigMap does not count as checking after', () => {
  const s = fresh('kube-config');
  play(s, 'kubectl logs deployment/web');
  play(s, `kubectl patch configmap greeting -p '{"data":{"GREETING":"hello from v2"}}'`);
  assert.equal(step('kube-config', 3).done(s), false);
  play(s, 'kubectl logs deployment/web');
  assert.equal(step('kube-config', 3).done(s), true);
});

test('config: the env value stays old until new pods start, and a restart fixes it', () => {
  const s = fresh('kube-config');
  play(s, `kubectl patch configmap greeting -p '{"data":{"GREETING":"hello from v2"}}'`);
  s.cluster.step(30);
  assert.match(play(s, 'kubectl logs deployment/web --tail=1'), /GREETING=hello from v1/, 'thirty ticks later, still v1');
  play(s, 'kubectl rollout restart deployment/web');
  until(s, () => step('kube-config', 4).done(s));
  s.cluster.step(3);
  assert.match(play(s, 'kubectl logs deployment/web --tail=1'), /GREETING=hello from v2/);
});

test('sidecars: applying the native version over the old Job is refused, because a Job template is immutable', () => {
  const s = fresh('kube-sidecars');
  const out = kubeRun(s, 'kubectl apply -f report-native.yaml');
  assert.match(out.map((l) => l.text).join('\n'), /The Job "nightly-report" is invalid: spec\.template: Invalid value: .*field is immutable/);
  s.cluster.step(40);
  assert.equal(step('kube-sidecars', 3).done(s), false);
});

test('nonroot: switching runAsNonRoot off starts web but does not pass', () => {
  const s = fresh('kube-nonroot');
  play(s, `kubectl patch deployment web -p '{"spec":{"template":{"spec":{"securityContext":{"runAsNonRoot":false}}}}}'`);
  until(s, () => (s.cluster.deploymentStatus('web').ready ?? 0) >= 1);
  assert.equal(s.cluster.deploymentStatus('web').ready, 1);
  assert.equal(step('kube-nonroot', 2).done(s), false);
});

test('nonroot: removing the restricted label lets api in, and does not pass', () => {
  const s = fresh('kube-nonroot');
  for (const c of commands(step('kube-nonroot', 2).hint!)) play(s, c);
  play(s, 'kubectl label namespace default pod-security.kubernetes.io/enforce=restricted');
  play(s, 'kubectl create deployment api --image=panda/hello-nonroot:1.0');
  s.cluster.step(4);
  play(s, 'kubectl label namespace default pod-security.kubernetes.io/enforce-');
  until(s, () => (s.cluster.deploymentStatus('api').ready ?? 0) >= 1, 60);
  assert.equal(s.cluster.deploymentStatus('api').ready, 1, 'api runs once the rule is gone');
  assert.equal(step('kube-nonroot', 5).done(s), false);
});

test('daemonset: a toleration for every taint fills the node but does not pass', () => {
  const s = fresh('kube-daemonset');
  play(s, `kubectl patch daemonset log-collector -p '{"spec":{"template":{"spec":{"tolerations":[{"operator":"Exists"}]}}}}'`);
  until(s, () => s.cluster.dsStatus(s.cluster.daemonsets.get(key('default', 'log-collector'))!).ready === 3);
  assert.equal(s.cluster.dsStatus(s.cluster.daemonsets.get(key('default', 'log-collector'))!).desired, 3);
  assert.equal(step('kube-daemonset', 3).done(s), false);
});

// The browser check once tainted worker-2 in the same second as the toleration
// patch: the collector's rollout then replaced its worker-2 pod after the
// taint and could not put it back, and a step that demanded it stay never ticked.
test('daemonset: tainting before the collector\'s rollout finishes still lets the mission finish', () => {
  const s = fresh('kube-daemonset');
  for (const c of ['kubectl get daemonsets', 'kubectl get nodes', 'kubectl describe node control-plane']) play(s, c);
  for (const c of commands(step('kube-daemonset', 3).hint!)) play(s, c);
  for (const c of commands(step('kube-daemonset', 4).hint!)) play(s, c);
  assert.ok(until(s, () => KUBE_A_MISSIONS['kube-daemonset'].steps.every((st) => st.done(s)), 120));
});

test('placement: deleting the nodeSelector schedules fast but does not pass', () => {
  const s = fresh('kube-placement');
  play(s, `kubectl patch deployment fast -p '{"spec":{"template":{"spec":{"nodeSelector":null}}}}'`);
  until(s, () => (s.cluster.deploymentStatus('fast').ready ?? 0) >= 1);
  assert.equal(s.cluster.deploymentStatus('fast').ready, 1);
  assert.equal(step('kube-placement', 2).done(s), false);
});

test('cron: a hand-made Job does not count as the schedule running again', () => {
  const s = fresh('kube-cron');
  play(s, 'kubectl create job nightly-now --from=cronjob/nightly');
  s.cluster.step(30);
  assert.equal(s.cluster.cronjobs.get(key('default', 'nightly'))!.suspend, true);
  assert.equal(step('kube-cron', 3).done(s), false, 'still suspended');
  assert.equal(step('kube-cron', 4).done(s), true, 'the manual run itself is fine');
});
