// Each test pins one thing a lesson tells the learner is true. If the sim
// drifted from these, a lesson would be teaching a reflex that fails on a real
// cluster - the failure shapes are copied from TemplateMechanics/tilt labs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cluster } from '../src/lib/kube/cluster.ts';
import { kubectl } from '../src/lib/kube/kubectl.ts';

const k = (c: Cluster, cmd: string) => kubectl(c, cmd).map((l) => l.text).join('\n');
const pods = (c: Cluster) => [...c.pods.values()].filter((p) => p.status !== 'Terminating');

test('a deleted pod is replaced by a new one with a different name', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment hello --image=panda/hello:1.0 --replicas=3');
  c.step(5);
  assert.equal(pods(c).filter((p) => p.ready).length, 3);
  const victim = pods(c)[0].name;
  assert.match(k(c, `kubectl delete pod ${victim}`), /deleted/);
  c.step(5);
  assert.equal(pods(c).filter((p) => p.ready).length, 3);
  assert.ok(!c.pods.has(victim), 'the replacement is a new pod, not the old one revived');
});

test('a pod that fits nowhere stays Pending and the reason is only in events', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment big --image=panda/hello:1.0 --replicas=3');
  k(c, 'kubectl set resources deployment big --requests=cpu=1500m');
  c.step(6);
  const pending = pods(c).filter((p) => !p.node);
  assert.equal(pending.length, 1);
  assert.match(k(c, `kubectl describe pod ${pending[0].name}`), /0\/2 nodes are available: 2 Insufficient cpu\. preemption: 0\/2 nodes are available: 2 No preemption victims found for incoming pod\./);
  // 400m, not 900m: new pods need room beside the old 1500m ones before the
  // old ones are allowed to leave (surge 1, unavailable 0 at 3 replicas).
  k(c, 'kubectl set resources deployment big --requests=cpu=400m');
  c.step(12);
  assert.equal(pods(c).filter((p) => p.ready).length, 3);
});

test('a quota refusal leaves no failing pod - only an event and a condition', () => {
  const c = new Cluster();
  k(c, 'kubectl create quota pandas --hard=pods=3');
  k(c, 'kubectl create deployment quota-demo --image=panda/hello:1.0 --replicas=6');
  c.step(6);
  assert.equal(pods(c).length, 3);
  assert.ok(pods(c).every((p) => p.ready), 'the pods that exist are all healthy');
  assert.match(k(c, 'kubectl get events'), /exceeded quota: pandas, requested: pods=1, used: pods=3, limited: pods=3/);
  assert.match(k(c, 'kubectl describe deploy quota-demo'), /ReplicaFailure\s+True\s+FailedCreate/);
  assert.doesNotMatch(k(c, 'kubectl get deploy'), /forbidden|exceeded|FailedCreate/, 'get deploy says 3/6 and never why');
  assert.match(k(c, 'kubectl get deploy'), /3\/6/);
  k(c, `kubectl patch quota/pandas -p '{"spec":{"hard":{"pods":"6"}}}'`);
  c.step(20);
  assert.equal(pods(c).filter((p) => p.ready).length, 6);
});

test('two crashes both exit 137 for opposite reasons', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment starved --image=panda/greedy:1.0');
  k(c, 'kubectl set resources deployment starved --limits=memory=64Mi');
  k(c, 'kubectl create deployment impatient --image=panda/slowpoke:1.0');
  c.step(12);
  const by = (n: string) => pods(c).find((p) => p.owner.startsWith(n + '-'))!;
  assert.equal(by('starved').last?.exitCode, 137);
  assert.equal(by('impatient').last?.exitCode, 137);
  assert.equal(by('starved').last?.reason, 'OOMKilled');
  assert.equal(by('impatient').last?.reason, 'Error');
  assert.match(k(c, `kubectl describe pod ${by('impatient').name}`), /Liveness probe failed/);
  assert.doesNotMatch(k(c, `kubectl describe pod ${by('starved').name}`), /Liveness probe failed/);
});

test('more memory does not fix the probe-killed pod; a startupProbe does', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment impatient --image=panda/slowpoke:1.0');
  k(c, 'kubectl set resources deployment impatient --limits=memory=1Gi');
  c.step(40);
  assert.equal(pods(c).filter((p) => p.ready).length, 0, 'still crash-looping with 1Gi');
  k(c, `kubectl patch deployment impatient -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","startupProbe":{"httpGet":{"path":"/","port":8080},"periodSeconds":5,"failureThreshold":24}}]}}}}'`);
  c.step(20);
  assert.equal(pods(c).filter((p) => p.ready).length, 1);
});

// The mission hint once added a bare startupProbe and the sim let a 60 s app
// start. On a real cluster the API defaults (periodSeconds 10, failureThreshold
// 3) give it 30 s, so the startup probe itself kills it: same crash loop, new
// event. The lab's fix.sh uses 5 x 24 for this reason.
test('a bare startupProbe patch would still kill a 60 s app on a real cluster', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment impatient --image=panda/slowpoke:1.0');
  k(c, `kubectl patch deployment impatient -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","startupProbe":{"httpGet":{"path":"/","port":8080}}}]}}}}'`);
  c.step(40);
  const p = pods(c).find((x) => x.owner.startsWith('impatient-'))!;
  assert.equal(p.ready, false, 'a 30 s startup budget cannot cover a 60 s start');
  assert.ok(p.restarts > 0);
  const out = k(c, `kubectl describe pod ${p.name}`);
  assert.match(out, /Startup probe failed/);
  assert.match(out, /Startup:\s+http-get http:\/\/:8080\/ delay=0s timeout=1s period=10s #success=1 #failure=3/);
});

test('the impatient liveness probe matches lab 09: checks from 5 s, kills on the second failure', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment impatient --image=panda/slowpoke:1.0');
  c.step(4);
  const p = pods(c)[0];
  assert.equal(p.restarts, 1, 'killed about 10 s after starting, long before its 60 s start-up');
  assert.match(k(c, `kubectl describe pod ${p.name}`), /Liveness:\s+http-get http:\/\/:8080\/ delay=5s timeout=1s period=5s #success=1 #failure=2/);
});

test('a typo in an image tag stalls the rollout and the old version keeps serving', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment hello --image=panda/hello:1.0 --replicas=3');
  c.step(5);
  k(c, 'kubectl set image deployment/hello app=panda/hello:2.O');
  c.step(15);
  const ready = pods(c).filter((p) => p.ready);
  assert.equal(ready.length, 3, 'no outage');
  assert.ok(ready.every((p) => p.template.image === 'panda/hello:1.0'));
  assert.match(k(c, 'kubectl get pods'), /ImagePullBackOff|ErrImagePull/);
  // kubectl's own wording while the new pod is stuck (Deployment docs, "rollout gets stuck").
  assert.match(k(c, 'kubectl rollout status deployment/hello'), /Waiting for deployment "hello" rollout to finish: 1 out of 3 new replicas have been updated\.\.\./);
  k(c, 'kubectl set image deployment/hello app=panda/hello:2.0');
  c.step(15);
  assert.ok(pods(c).every((p) => p.ready && p.template.image === 'panda/hello:2.0'));
  assert.equal(pods(c).length, 3);
});

test('the missing-config crash is exit 1 and says why in the previous logs', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment api --image=panda/needs-config:1.0');
  c.step(6);
  const p = pods(c)[0];
  assert.equal(p.last?.exitCode, 1);
  assert.match(k(c, `kubectl logs ${p.name} --previous`), /DATABASE_URL is not set/);
  k(c, 'kubectl set env deployment/api DATABASE_URL=postgres://db:5432/pandas');
  c.step(10);
  assert.equal(pods(c).filter((x) => x.ready).length, 1);
});
