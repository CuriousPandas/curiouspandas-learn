// What the review of the workloads lessons found KubeSim printing that no real
// cluster would, pinned against what one did. Unless a comment says otherwise
// the source is kubectl 1.37.2 against the tilt platform's kind v1.36.1
// cluster (kind-tiltdev), in a scratch namespace, on 2026-11-03, and for the
// controller logic the Kubernetes source at release-1.36. Names, uids and
// ages differ; shapes, words and counts must not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cluster } from '../src/lib/kube/cluster.ts';
import { kubectl, tabw } from '../src/lib/kube/kubectl.ts';
import { KUBE_A_MISSIONS, kubeRun } from '../src/lib/kube/missions.ts';
import { KUBE_MISSIONS, kubeObserve, kubeWatch } from '../src/lib/missions.ts';

const k = (c: Cluster, cmd: string, files = {}) => kubectl(c, cmd, undefined, files).map((l) => l.text).join('\n');
const errs = (c: Cluster, cmd: string) => kubectl(c, cmd).filter((l) => l.kind === 'err').map((l) => l.text).join('\n');
const rsRows = (c: Cluster) => [...c.replicasets.values()].sort((a, b) => a.created - b.created).map((r) => [r.replicas, c.live(r.name, r.ns).length]);
const between = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));

function typoAt(replicas: number) {
  const c = new Cluster();
  k(c, `kubectl create deployment hello --image=panda/hello:1.0 --replicas=${replicas}`);
  c.step(6);
  k(c, 'kubectl set image deploy/hello app=panda/hello:2.O');
  c.step(4);
  return c;
}

// ---- Deployments --------------------------------------------------------

test('a broken tag at 4 replicas leaves old 3 / new 2, and at 10 leaves old 8 / new 5, as on kind', () => {
  // Original failure: the sandbox always used surge 1 / unavailable 0, so at
  // 4 or 10 replicas it removed no old pod where a real cluster removes 1 or 2.
  assert.deepEqual(rsRows(typoAt(4)), [[3, 3], [2, 2]]);
  assert.deepEqual(rsRows(typoAt(10)), [[8, 8], [5, 5]]);
  // And at the 3 replicas the missions use: surge 1, unavailable 0, nothing old removed.
  assert.deepEqual(rsRows(typoAt(3)), [[3, 3], [1, 1]]);
});

test('the rollout\'s ScalingReplicaSet events come in kind\'s order and wording', () => {
  const c = typoAt(4);
  const msgs = c.events.filter((e) => e.reason === 'ScalingReplicaSet').map((e) => e.message.replace(/hello-\w+/, 'RS'));
  // Live: from 0 to 4; new from 0 to 1; old from 4 to 3; new from 1 to 2.
  assert.deepEqual(msgs, ['Scaled up replica set RS from 0 to 4', 'Scaled up replica set RS from 0 to 1', 'Scaled down replica set RS from 4 to 3', 'Scaled up replica set RS from 1 to 2']);
});

test('describe deploy has the real header lines, conditions and ReplicaSet lines', () => {
  const c = new Cluster();
  k(c, 'kubectl create deployment hello --image=panda/hello:1.0 --replicas=4');
  c.step(6);
  const out = k(c, 'kubectl describe deploy hello');
  for (const line of [
    /^CreationTimestamp:      \w{3}, \d\d \w{3} \d{4} \d\d:\d\d:\d\d [+-]\d{4}$/m,
    /^Annotations:            deployment\.kubernetes\.io\/revision: 1$/m,
    /^Replicas:               4 desired \| 4 updated \| 4 total \| 4 available \| 0 unavailable$/m,
    /^StrategyType:           RollingUpdate$/m,
    /^MinReadySeconds:        0$/m,
    /^RollingUpdateStrategy:  25% max unavailable, 25% max surge$/m,
  ]) assert.match(out, line);
  // Copied: the settled Deployment's block, character for character but the hash.
  assert.equal(between(out, 'Conditions:', 'Events:').replace(/hello-\w+/, 'hello-HASH'), [
    'Conditions:',
    '  Type           Status  Reason',
    '  ----           ------  ------',
    '  Available      True    MinimumReplicasAvailable',
    '  Progressing    True    NewReplicaSetAvailable',
    'OldReplicaSets:  <none>',
    'NewReplicaSet:   hello-HASH (4/4 replicas created)',
    '',
  ].join('\n'));
  assert.doesNotMatch(out, /maxSurge 1|SuccessfulCreate/);
});

test('describe deploy shows only the Deployment\'s events: the refusal is on the ReplicaSet', () => {
  // Original failure: describe deploy mixed in the ReplicaSet's SuccessfulCreate
  // and FailedCreate, so learners were taught to find a refusal there.
  const c = new Cluster();
  k(c, 'kubectl create quota pandas --hard=pods=2');
  k(c, 'kubectl create deployment quota-demo --image=panda/hello:1.0 --replicas=4');
  c.step(4);
  const d = k(c, 'kubectl describe deploy quota-demo');
  assert.doesNotMatch(d, /FailedCreate\s+\d|SuccessfulCreate|exceeded quota/);
  assert.match(d, /^  ReplicaFailure   True    FailedCreate$/m, 'the condition row ends in a space before its tab, so ReplicaFailure widens the block');
  assert.match(d, /^OldReplicaSets:    <none>$/m);
  assert.match(d, /^NewReplicaSet:     quota-demo-\w+ \(2\/4 replicas created\)$/m);
  const rs = k(c, 'kubectl describe rs');
  assert.match(rs, /Warning  FailedCreate\s+\S+\s+replicaset-controller  Error creating: pods "quota-demo-\w+-\w+" is forbidden: exceeded quota: pandas, requested: pods=1, used: pods=2, limited: pods=2/);
  assert.match(rs, /^Annotations:    deployment\.kubernetes\.io\/desired-replicas: 4\n                deployment\.kubernetes\.io\/max-replicas: 5\n                deployment\.kubernetes\.io\/revision: 1$/m);
});

test('Available follows maxUnavailable, not "all of them": 3 of 4 is available, 2 of 4 is not', () => {
  // kind: quota 2 short of 4 replicas left 3 Running and "Available True".
  const c = new Cluster();
  k(c, 'kubectl create quota pandas --hard=pods=3');
  k(c, 'kubectl create deployment q --image=panda/hello:1.0 --replicas=4');
  c.step(6);
  assert.match(k(c, 'kubectl describe deploy q'), /Available        True    MinimumReplicasAvailable/);
  const c2 = new Cluster();
  k(c2, 'kubectl create quota pandas --hard=pods=2');
  k(c2, 'kubectl create deployment q --image=panda/hello:1.0 --replicas=4');
  c2.step(6);
  assert.match(k(c2, 'kubectl describe deploy q'), /Available        False   MinimumReplicasUnavailable/);
});

test('a stuck rollout reports ProgressDeadlineExceeded after its deadline, and rollout status fails', () => {
  // Original gap: no Progressing condition at all, so the deadline the rollouts lesson teaches never appeared.
  const c = new Cluster();
  k(c, 'kubectl create deployment hello --image=panda/hello:1.0 --replicas=4');
  c.step(6);
  assert.equal(k(c, `kubectl patch deploy hello -p '{"spec":{"progressDeadlineSeconds":30}}'`), 'deployment.apps/hello patched');
  k(c, 'kubectl set image deploy/hello app=panda/hello:2.O');
  c.step(3);
  assert.equal(k(c, 'kubectl rollout status deploy/hello'), 'Waiting for deployment "hello" rollout to finish: 2 out of 4 new replicas have been updated...');
  assert.match(k(c, 'kubectl describe deploy hello'), /Progressing    True    ReplicaSetUpdated/);
  c.step(7);
  // Copied (exit 1 on the real one).
  assert.equal(errs(c, 'kubectl rollout status deploy/hello'), 'error: deployment "hello" exceeded its progress deadline');
  const out = k(c, 'kubectl describe deploy hello');
  assert.match(out, /^  Available      True    MinimumReplicasAvailable\n  Progressing    False   ProgressDeadlineExceeded$/m);
  assert.match(out, /^Replicas:               4 desired \| 2 updated \| 5 total \| 3 available \| 2 unavailable$/m);
  assert.match(out, /^OldReplicaSets:  hello-\w+ \(3\/3 replicas created\)\nNewReplicaSet:   hello-\w+ \(2\/2 replicas created\)$/m);
  assert.match(k(c, "kubectl get deploy hello -o jsonpath='{.status.conditions[1].message}'"), /^ReplicaSet "hello-\w+" has timed out progressing\.$/);
  // Undo makes progress again, and the condition comes back True.
  k(c, 'kubectl rollout undo deploy/hello');
  c.step(6);
  assert.match(k(c, 'kubectl describe deploy hello'), /Progressing    True    NewReplicaSetAvailable/);
  assert.equal(k(c, 'kubectl rollout status deploy/hello'), 'deployment "hello" successfully rolled out');
});

test('the default deadline is 600 s: a typo at 3 replicas is still Progressing at 9 minutes, timed out after 10', () => {
  const c = typoAt(3);
  c.step(105);
  assert.match(k(c, 'kubectl describe deploy hello'), /Progressing    True    ReplicaSetUpdated/);
  c.step(20);
  assert.match(k(c, 'kubectl describe deploy hello'), /Progressing    False   ProgressDeadlineExceeded/);
});

test('resourceVersion changes on a write and stays put when nothing changed', () => {
  // Original failure: it stayed "1003" through kubectl scale.
  const c = new Cluster();
  k(c, 'kubectl create deployment hello --image=panda/hello:1.0');
  c.step(4);
  const rv = () => k(c, "kubectl get deploy hello -o jsonpath='{.metadata.resourceVersion}'");
  const a = rv();
  assert.equal(rv(), a, 'two looks with no write between them');
  k(c, 'kubectl scale deploy hello --replicas=2');
  c.step(1);
  const b = rv();
  assert.notEqual(b, a);
  assert.ok(Number(b) > Number(a), 'resourceVersions only go up');
});

// ---- describe shapes ------------------------------------------------------

test('a Pod Template block lines up the way kubectl\'s tabwriter does', () => {
  // Copied from describe deploy of a Deployment with env from a ConfigMap and
  // a Secret, three volumes and two tolerations. The probe line and the init
  // container's Command differ there, so the comparison starts after them.
  const dep = {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'rich', labels: { app: 'rich' } },
    spec: { replicas: 1, selector: { matchLabels: { app: 'rich' } }, template: { metadata: { labels: { app: 'rich' } }, spec: {
      containers: [{ name: 'app', image: 'panda/hello:1.0',
        env: [{ name: 'GREETING', valueFrom: { configMapKeyRef: { name: 'greeting', key: 'GREETING' } } }, { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'db', key: 'DATABASE_URL' } } }, { name: 'MODE', value: 'test' }],
        envFrom: [{ configMapRef: { name: 'greeting' } }],
        volumeMounts: [{ name: 'g', mountPath: '/etc/greeting' }, { name: 's', mountPath: '/etc/db' }, { name: 'tmp', mountPath: '/tmp' }] }],
      volumes: [{ name: 'g', configMap: { name: 'greeting' } }, { name: 's', secret: { secretName: 'db' } }, { name: 'tmp', emptyDir: {} }],
      tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'gpu', effect: 'NoSchedule' }, { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' }],
    } } },
  };
  const c = new Cluster();
  k(c, 'kubectl create configmap greeting --from-literal=GREETING=hi');
  k(c, 'kubectl create secret generic db --from-literal=DATABASE_URL=x');
  assert.equal(k(c, 'kubectl apply -f rich.yaml', { 'rich.yaml': dep }), 'deployment.apps/rich created');
  c.step(1);
  const out = k(c, 'kubectl describe deploy rich');
  assert.equal(between(out, '    Environment Variables from:', 'Conditions:'), `    Environment Variables from:
      greeting  ConfigMap  Optional: false
    Environment:
      GREETING:      <set to the key 'GREETING' of config map 'greeting'>  Optional: false
      DATABASE_URL:  <set to the key 'DATABASE_URL' in secret 'db'>        Optional: false
      MODE:          test
    Mounts:
      /etc/db from s (rw)
      /etc/greeting from g (rw)
      /tmp from tmp (rw)
  Volumes:
   g:
    Type:      ConfigMap (a volume populated by a ConfigMap)
    Name:      greeting
    Optional:  false
   s:
    Type:        Secret (a volume populated by a Secret)
    SecretName:  db
    Optional:    false
   tmp:
    Type:          EmptyDir (a temporary directory that shares a pod's lifetime)
${'    Medium:'.padEnd(19)}
    SizeLimit:     <unset>
  Node-Selectors:  <none>
  Tolerations:     dedicated=gpu:NoSchedule
                   node-role.kubernetes.io/control-plane:NoSchedule op=Exists
`);
  // The container's first lines, as an nginx template with no resources printed them.
  assert.match(out, /^   app:\n    Image:      panda\/hello:1\.0\n    Port:       <none>\n    Host Port:  <none>\n    Limits:\n      memory:  128Mi\n    Requests:\n/m);
});

test('tabw pads each column of a block to its widest cell plus two, and a tabless line ends the block', () => {
  assert.equal(tabw('a:\t1\nlong-key:\t2\nbreak\nb:\t3'), 'a:         1\nlong-key:  2\nbreak\nb:  3');
});

test('describe pod: probes in kubectl 1.37\'s wording, Started as a time, and no <none> probe lines', () => {
  // Copied from a podinfo pod on the platform: "http-get ... successThreshold=1 failureThreshold=3",
  // "Started:      Mon, 02 Nov 2026 22:33:22 -0600".
  const c = new Cluster();
  k(c, 'kubectl create deployment hello --image=panda/hello:1.0');
  c.step(3);
  const p = [...c.pods.values()][0];
  const out = k(c, `kubectl describe pod ${p.name}`);
  assert.match(out, /^    Liveness:     http-get http:\/\/:8080\/ delay=5s timeout=1s period=5s successThreshold=1 failureThreshold=2$/m);
  assert.match(out, /^      Started:      \w{3}, \d\d \w{3} \d{4} \d\d:\d\d:\d\d \+0000$/m);
  assert.doesNotMatch(out, /Startup:|#success|<none>\n    Startup/);
  assert.match(out, /^    Port:           <none>\n    Host Port:      <none>\n    State:          Running$/m);
  // Events are padded with two spaces in describe, three in get.
  assert.match(out, /^  Type    Reason     Age   From               Message$/m);
});

test('a pod no node has taken: no State, Ready or Restart Count, empty logs, no container statuses', () => {
  // Original failure: "State: Waiting / Reason: Pending" and "is waiting to start: Pending".
  // On kind, describe printed no State line, logs printed nothing (exit 0), status had no containerStatuses.
  const c = new Cluster();
  k(c, `kubectl run sel --image=panda/hello:1.0 --overrides='{"spec":{"nodeSelector":{"disktype":"nope"}}}'`);
  c.step(2);
  const out = k(c, 'kubectl describe pod sel');
  assert.doesNotMatch(out, /State:|Ready:|Restart Count:/);
  assert.match(out, /^  sel:\n    Image:      panda\/hello:1\.0\n    Port:       <none>\n    Host Port:  <none>\n/m);
  assert.deepEqual(kubectl(c, 'kubectl logs sel'), []);
  assert.doesNotMatch(k(c, "kubectl get pod sel -o jsonpath='{.status}'"), /containerStatuses/);
});

test('get nodes has kubectl\'s columns only; the CPU numbers are in describe node', () => {
  // Original failure: CPU (requested/allocatable) and MEMORY columns no real cluster prints.
  const c = new Cluster();
  k(c, 'kubectl create deployment hello --image=panda/hello:1.0');
  c.step(3);
  assert.match(k(c, 'kubectl get nodes'), /^NAME       STATUS   ROLES    AGE   VERSION\nworker-1   Ready    <none>   \S+   v1\.36\.1$/m);
  assert.match(k(c, 'kubectl get nodes -o wide').split('\n')[0], /^NAME\s+STATUS\s+ROLES\s+AGE\s+VERSION\s+INTERNAL-IP\s+EXTERNAL-IP\s+OS-IMAGE\s+KERNEL-VERSION\s+CONTAINER-RUNTIME$/);
  const node = [...c.pods.values()][0].node!;
  const d = k(c, `kubectl describe node ${node}`);
  assert.match(d, /^  Namespace  Name\s+CPU Requests  CPU Limits  Memory Requests  Memory Limits  Age$/m);
  assert.match(d, /^  Resource           Requests   Limits\n  --------           --------   ------\n  cpu                100m \(5%\)  0 \(0%\)\n  memory             64Mi \(1%\)  128Mi \(3%\)\n  ephemeral-storage  0 \(0%\)     0 \(0%\)$/m);
});

// ---- pods with more than one container ------------------------------------

test('a native sidecar Job: Init:0/1, 2/2 Running, 1/2 Completed while phase is Running, then 0/2 Completed', () => {
  // Original failure: Init:1/1 and PodInitializing (which kubectl never prints
  // for a started sidecar), and phase Succeeded during the grace period.
  const job = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'native' }, spec: { template: { spec: { restartPolicy: 'Never', initContainers: [{ name: 'log-shipper', image: 'panda/log-shipper:1.0', restartPolicy: 'Always' }], containers: [{ name: 'report', image: 'panda/report:1.0' }] } } } };
  const c = new Cluster();
  k(c, 'kubectl apply -f j.yaml', { 'j.yaml': job });
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    c.step();
    const p = [...c.pods.values()][0];
    if (!p || !p.node) continue;
    const s = `${c.podReady(p)} ${c.podStatus(p)} ${c.podPhase(p)}`;
    if (seen[seen.length - 1] !== s) seen.push(s);
  }
  assert.deepEqual(seen, ['0/2 Init:0/1 Pending', '2/2 Running Running', '1/2 Completed Running', '0/2 Completed Succeeded']);
  assert.match(k(c, 'kubectl get job native'), /native\s+Complete\s+1\/1/);
});

test('describe job prints Start Time and Completed At as times, not ages', () => {
  // kind: "Start Time:       Tue, 03 Nov 2026 03:22:34 -0600".
  const c = new Cluster();
  k(c, 'kubectl create job quick --image=panda/report:1.0');
  c.step(8);
  const out = k(c, 'kubectl describe job quick');
  assert.match(out, /^Start Time:       Tue, 03 Nov 2026 06:00:00 \+0000\nCompleted At:     Tue, 03 Nov 2026 06:00:\d\d \+0000\nDuration:         \d+s$/m);
});

test('UnexpectedJob is reported once for a hand-made Job, not every other tick for ever', () => {
  // Original failure: x20 over 3m10s for a Job long since complete. Live it fired once.
  const c = new Cluster();
  k(c, `kubectl create cronjob nightly --image=panda/report:1.0 --schedule='0 3 * * *'`);
  k(c, 'kubectl create job now --from=cronjob/nightly');
  c.step(60);
  const ev = c.events.filter((e) => e.reason === 'UnexpectedJob');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].count, 1);
  assert.ok(!c.events.some((e) => e.reason === 'SawCompletedJob'), 'SawCompletedJob is only for Jobs in the CronJob\'s active list (cronjob_controllerv2.go)');
});

// ---- taints and refusals --------------------------------------------------

test('taint parse errors are kubectl\'s own (taint --dry-run=client)', () => {
  const c = new Cluster();
  assert.equal(errs(c, 'kubectl taint node worker-1 bad=yes:NoExecut'), "error: invalid taint effect: NoExecut, unsupported taint effect\nSee 'kubectl taint -h' for help and examples");
  assert.equal(errs(c, 'kubectl taint node worker-1 a=b=c:NoSchedule'), "error: invalid taint spec: a=b=c:NoSchedule\nSee 'kubectl taint -h' for help and examples");
  assert.equal(errs(c, 'kubectl taint node worker-1 bad=yes'), "error: invalid taint spec: bad=yes, name part must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyName',  or 'my.name',  or '123-abc', regex used for validation is '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]')\nSee 'kubectl taint -h' for help and examples");
  assert.equal(errs(c, 'kubectl taint node worker-1 bad'), 'error: at least one taint update is required');
  assert.equal(errs(c, 'kubectl taint node worker-1 nosuch-'), 'error: taint "nosuch" not found');
});

test('kubectl events is real, so it is refused as a sandbox limit, not as an unknown command', () => {
  const out = errs(new Cluster(), 'kubectl events');
  assert.match(out, /real kubectl has this; this sandbox does not/);
  assert.doesNotMatch(out, /unknown command/);
});

// ---- missions changed by these fixes ----------------------------------------

test('config: envFrom with the Secret is a correct answer too; the plain value is not', () => {
  // Original failure: envFrom gave api its password and it ran, but the step stayed unticked.
  const m = KUBE_A_MISSIONS['kube-config'];
  const s = m.setup();
  kubeRun(s, 'kubectl create secret generic db --from-literal=DATABASE_URL=postgres://db:5432/shop');
  kubeRun(s, `kubectl patch deployment api -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","envFrom":[{"secretRef":{"name":"db"}}]}]}}}}'`);
  for (let i = 0; i < 40 && !m.steps[4].done(s); i++) s.cluster.step();
  assert.equal(m.steps[4].done(s), true);
  // A ConfigMap holding the same value is not a Secret.
  const s2 = m.setup();
  kubeRun(s2, 'kubectl create configmap dbcm --from-literal=DATABASE_URL=postgres://db:5432/shop');
  kubeRun(s2, `kubectl patch deployment api -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","envFrom":[{"configMapRef":{"name":"dbcm"}}]}]}}}}'`);
  s2.cluster.step(40);
  assert.equal(m.steps[4].done(s2), false);
});

const playOld = (s: ReturnType<typeof KUBE_MISSIONS['kube-pending']['setup']>, cmd: string) => { kubeObserve(s, cmd); kubectl(s.cluster, cmd); kubeWatch(s); };

test('pending: get nodes no longer counts as seeing how full the nodes are; describe node does', () => {
  const m = KUBE_MISSIONS['kube-pending'];
  const s = m.setup();
  playOld(s, 'kubectl get nodes');
  assert.equal(m.steps[2].done(s), false, 'get nodes shows no CPU on a real cluster');
  playOld(s, 'kubectl describe node worker-2');
  assert.equal(m.steps[2].done(s), true);
});

test('quota: describe rs is where the refusal text is, and counts', () => {
  const m = KUBE_MISSIONS['kube-quota'];
  const s = m.setup();
  playOld(s, 'kubectl get pods');
  assert.equal(m.steps[1].done(s), false, 'looking at pods finds no refusal');
  playOld(s, 'kubectl describe replicaset');
  assert.equal(m.steps[1].done(s), true);
});
