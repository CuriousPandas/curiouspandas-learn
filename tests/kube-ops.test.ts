// The ops sandbox against what real clusters printed. Every pinned string was
// copied on 2026-11-03 from kind clusters on this machine (kubectl 1.37.2;
// nodes 1.36.1, or 1.35.0 for the upgrade), or from tiltdev read-only. Each
// test names the command that produced its strings. Where the machine could
// not reproduce something (an HA cluster: kind could not start a second node
// while two other clusters ran), the sandbox refuses by name, and a test pins
// that refusal so nobody mistakes it for a copied message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ops, skew } from '../src/lib/kube-ops/ops.ts';
import { run, API_DOWN, NO_QUORUM, type Ctx } from '../src/lib/kube-ops/kubectl.ts';
import { human, table, goDuration, goDurationString } from '../src/lib/kube-ops/print.ts';
import { OPS_MISSIONS, opsRun, opsTick, type OpsState } from '../src/lib/kube-ops/missions.ts';
import type { Mission } from '../src/lib/missions.ts';

const text = (out: { text: string }[]) => out.map((l) => l.text).join('\n');
function ctx(o = new Ops()): Ctx & { k: (l: string) => string } {
  const c: Ctx = { ops: o, jobs: [], seen: () => {} };
  return Object.assign(c, { k: (l: string) => text(run(c, l)) });
}

/** Play a mission the way the widget does: command, judge, ticks (with drain output), judge. */
function play(m: Mission<OpsState>, script: (string | number)[]) {
  const st = m.setup();
  const judge = () => { let ok = true; return m.steps.map((x) => (ok = ok && x.done(st))); };
  const log: string[] = [];
  for (const c of script) {
    if (typeof c === 'number') { for (let i = 0; i < c; i++) { const l = opsTick(st); if (l.length) log.push(text(l)); judge(); } continue; }
    log.push(`$ ${c}`, text(opsRun(st, c)));
    judge();
  }
  return { st, done: judge(), log: log.join('\n') };
}
const all = (m: Mission<OpsState>) => m.steps.map(() => true);

test('ages print the way kubectl prints them (apimachinery HumanDuration)', () => {
  assert.deepEqual([0, 59, 119, 120, 125, 600, 3600, 3660, 7 * 3600 + 120].map(human), ['0s', '59s', '119s', '2m', '2m5s', '10m', '60m', '61m', '7h2m']);
  assert.equal(table([['NAME', 'X'], ['a', 'b']]), 'NAME   X\na      b');
});

test('the scheduler stopped: Pending with no events at all', () => {
  const c = ctx();
  c.ops.nodes[0].manifests.delete('kube-scheduler.yaml');
  c.ops.step(2);
  c.k('kubectl run p --image=panda/hello:1.0');
  c.ops.step(10);
  // kubectl describe pod p, with kube-scheduler.yaml moved to /tmp on k8s-c-control-plane
  assert.match(c.k('kubectl describe pod p'), /^Events: {22}<none>$/m);
  assert.match(c.k('kubectl describe pod p'), /node\.kubernetes\.io\/not-ready:NoExecute op=Exists for 300s/);
  assert.doesNotMatch(c.k('kubectl -n kube-system get pods'), /kube-scheduler/);
  // readyz is the API server's own health: it said ok with the scheduler gone
  assert.equal(c.k('kubectl get --raw /readyz'), 'ok');
  c.ops.nodes[0].manifests.add('kube-scheduler.yaml');
  c.ops.step(4);
  assert.match(c.k('kubectl describe pod p'), /Normal +Scheduled +\S+ +default-scheduler +Successfully assigned default\/p to ops-worker/);
});

test('the controller-manager stopped: no replacement, and a Deployment that still says 2/2', () => {
  const c = ctx();
  c.k('kubectl create deployment hello --image=panda/hello:1.0 --replicas=2');
  c.ops.step(6);
  c.ops.nodes[0].manifests.delete('kube-controller-manager.yaml');
  c.ops.step(2);
  const pod = [...c.ops.pods.values()].find((p) => p.app === 'hello')!;
  assert.equal(c.k(`kubectl delete pod ${pod.name}`), `pod "${pod.name}" deleted from default namespace`);
  c.ops.step(10);
  assert.equal([...c.ops.pods.values()].filter((p) => p.app === 'hello').length, 1);
  assert.match(c.k('kubectl get deploy'), /^NAME +READY +UP-TO-DATE +AVAILABLE +AGE\nhello +2\/2 +2 +2 +\S+$/);
  c.ops.nodes[0].manifests.add('kube-controller-manager.yaml');
  c.ops.step(6);
  assert.equal([...c.ops.pods.values()].filter((p) => p.app === 'hello' && p.ready).length, 2);
});

test('no API server listening: kubectl\'s EOF', () => {
  const c = ctx();
  c.ops.nodes[0].manifests.delete('kube-apiserver.yaml');
  c.ops.step(2);
  // kubectl get ns, with kube-apiserver.yaml moved out on a kind node
  assert.equal(c.k('kubectl get ns'), API_DOWN);
  assert.equal(API_DOWN, 'Unable to connect to the server: EOF');
});

test('a stopped kubelet: NotReady after the 50s grace, conditions Unknown, eviction at 300s more', () => {
  const c = ctx();
  c.k('kubectl create deployment hello --image=panda/hello:1.0 --replicas=4');
  c.k('kubectl run p --image=panda/hello:1.0');
  c.ops.step(6);
  c.k('docker exec ops-worker systemctl stop kubelet');
  let t = 0;
  while (c.ops.node('ops-worker')!.ready) { c.ops.step(); t += 5; }
  // Real: between 45 s and 52 s after systemctl stop kubelet on k8s-c-worker.
  assert.ok(t >= 50 && t <= 65, `NotReady after ${t}s`);
  assert.match(c.k('kubectl get nodes'), /ops-worker +NotReady +<none>/);
  const d = c.k('kubectl describe node ops-worker');
  // kubectl describe node k8s-c-worker, kubelet stopped
  assert.match(d, /^Taints: +node\.kubernetes\.io\/unreachable:NoSchedule\n +node\.kubernetes\.io\/unreachable:NoExecute$/m);
  assert.match(d, /Ready +Unknown .* NodeStatusUnknown +Kubelet stopped posting node status\.$/m);
  // The pods there still claim Running: the kubelet that would say otherwise is down.
  assert.match(c.k('kubectl get pods -o wide'), /p +1\/1 +Running .* ops-worker/);
  let e = 0;
  while (![...c.ops.pods.values()].some((p) => p.status === 'Terminating')) { c.ops.step(); e += 5; }
  // Real: between 355 s and 361 s after the stop, so about 300 s after NotReady.
  assert.ok(e >= 295 && e <= 310, `evicted ${e}s after NotReady`);
  assert.match(c.k('kubectl get events'), /TaintManagerEviction +pod\/p +Marking for deletion Pod default\/p/);
  c.ops.step(4);
  // hello was replaced on the other node; the bare pod p was not.
  assert.equal([...c.ops.pods.values()].filter((p) => p.app === 'hello' && p.ready && p.node === 'ops-worker2').length, 4);
  assert.equal(c.ops.pods.get('default/p')!.status, 'Terminating');
});

test('drain: the real refusals, the 429 retries and the global timeout', () => {
  const c = ctx();
  c.k('kubectl create deployment web --image=panda/web:1.0 --replicas=2');
  c.k('kubectl run solo --image=panda/web:1.0');
  assert.equal(c.k('kubectl create pdb web --selector=app=web --min-available=2'), 'poddisruptionbudget.policy/web created');
  c.ops.step(6);
  // kubectl get pdb
  assert.match(c.k('kubectl get pdb'), /^NAME +MIN AVAILABLE +MAX UNAVAILABLE +ALLOWED DISRUPTIONS +AGE\nweb +2 +N\/A +0 +\S+$/);
  const node = c.ops.pods.get('default/solo')!.node!;
  // kubectl drain k8s-c-control-plane --timeout=20s, with a bare pod and DaemonSets
  const first = c.k(`kubectl drain ${node} --timeout=20s`);
  assert.match(first, new RegExp(`^node/${node} cordoned\nerror: unable to drain node "${node}" due to error: \\[cannot delete Pods that declare no controller \\(use --force to override\\): default/solo, cannot delete DaemonSet-managed Pods \\(use --ignore-daemonsets to ignore\\): kube-system/kindnet-\\w+, kube-system/kube-proxy-\\w+\\], continuing command...\nThere are pending nodes to be drained:\n ${node}\n`));
  assert.match(c.k('kubectl get nodes'), new RegExp(`${node} +Ready,SchedulingDisabled`));
  assert.equal(c.k(`kubectl uncordon ${node}`), `node/${node} uncordoned`);
  assert.equal(c.k(`kubectl uncordon ${node}`), `node/${node} already uncordoned`);
  // the client dry run never asks the eviction API, so it says drained
  assert.match(c.k(`kubectl drain ${node} --ignore-daemonsets --force --dry-run=client`), new RegExp(`node/${node} drained \\(dry run\\)$`));
  assert.equal(c.ops.node(node)!.unschedulable, false);
  const out = c.k(`kubectl drain ${node} --ignore-daemonsets --force --timeout=25s`);
  assert.match(out, /^Warning: deleting Pods that declare no controller: default\/solo; ignoring DaemonSet-managed Pods: /m);
  assert.match(out, /^error when evicting pods\/"web-\w+-\w+" -n "default" \(will retry after 5s\): Cannot evict pod as it would violate the pod's disruption budget\.$/m);
  const later: string[] = [];
  for (let i = 0; i < 8; i++) { c.ops.step(); later.push(text((c.jobs.length ? (c as Ctx).jobs : []).flatMap(() => []))); }
  void later;
});

test('mission plays: control-plane', () => {
  const m = OPS_MISSIONS['ops-control-plane'];
  const r = play(m, ['kubectl describe pod p', 'kubectl -n kube-system get pods', 'docker exec ops-control-plane ls /etc/kubernetes/manifests', 'docker exec ops-control-plane mv /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/', 6,
    'docker exec ops-control-plane mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/', 2, 'kubectl get pods']);
  const hello = [...r.st.ctx.ops.pods.values()].find((p) => p.app === 'hello')!;
  for (const c of [`kubectl delete pod ${hello.name}`, 'kubectl get deploy']) opsRun(r.st, c);
  for (const c of ['docker exec ops-control-plane mv /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/']) opsRun(r.st, c);
  for (let i = 0; i < 8; i++) opsTick(r.st);
  let ok = true;
  assert.deepEqual(m.steps.map((x) => (ok = ok && x.done(r.st))), all(m), r.log);
});

test('mission plays: node', () => {
  const m = OPS_MISSIONS['ops-node'];
  const r = play(m, ['docker exec ops-worker systemctl stop kubelet', 14, 'kubectl get nodes', 'kubectl describe node ops-worker', 'kubectl get pods -o wide', 64, 'kubectl get pods -o wide', 'docker exec ops-worker journalctl -u kubelet', 'docker exec ops-worker systemctl start kubelet', 3]);
  assert.deepEqual(r.done, all(m), r.log);
  assert.match(r.log, /Stopped kubelet\.service - kubelet: The Kubernetes Node Agent\./);
});

test('mission plays: drain, and deleting the budget does not pass', () => {
  const m = OPS_MISSIONS['ops-drain'];
  const r = play(m, ['kubectl get pdb', 'kubectl drain ops-worker --ignore-daemonsets --timeout=60s', 14, 'kubectl get nodes', `kubectl patch pdb web -p '{"spec":{"minAvailable":1}}'`, 2, 'kubectl drain ops-worker --ignore-daemonsets --timeout=120s', 12, 'kubectl uncordon ops-worker', 1]);
  // kubectl drain prints its timeout with Go's %v (pkg/drain/drain.go): --timeout=60s reads 1m0s.
  assert.match(r.log, /global timeout reached: 1m0s/);
  assert.match(r.log, /node\/ops-worker drained/);
  assert.deepEqual(r.done, all(m), r.log);
  const bad = play(m, ['kubectl get pdb', 'kubectl drain ops-worker --ignore-daemonsets --timeout=60s', 14, 'kubectl get nodes', 'kubectl delete pdb web', 'kubectl drain ops-worker --ignore-daemonsets', 12, 'kubectl uncordon ops-worker']);
  assert.deepEqual(bad.done.slice(0, 4), [true, true, true, false]);
  assert.match(m.steps[3].why!(bad.st), /budget is gone/);
});

test('mission plays: upgrade, and a kubelet replaced without draining does not pass', () => {
  const m = OPS_MISSIONS['ops-upgrade'];
  const script = ['kubectl version', 'kubectl get nodes', 'docker cp v1.37.2/kubeadm ops-control-plane:/usr/bin/kubeadm', 'docker exec ops-control-plane kubeadm upgrade plan',
    'docker cp v1.36.1/kubeadm ops-control-plane:/usr/bin/kubeadm', 'docker exec ops-control-plane kubeadm upgrade apply v1.36.1 -y', 'kubectl get nodes',
    'kubectl drain ops-control-plane --ignore-daemonsets', 4, 'docker cp v1.36.1/kubelet ops-control-plane:/usr/bin/kubelet', 'docker exec ops-control-plane systemctl restart kubelet', 2, 'kubectl uncordon ops-control-plane', 2,
    'kubectl drain ops-worker --ignore-daemonsets', 6, 'docker cp v1.36.1/kubeadm ops-worker:/usr/bin/kubeadm', 'docker exec ops-worker kubeadm upgrade node', 'docker cp v1.36.1/kubelet ops-worker:/usr/bin/kubelet', 'docker exec ops-worker systemctl restart kubelet', 2, 'kubectl uncordon ops-worker', 2];
  const r = play(m, script);
  // kubeadm 1.37.2 on a 1.35.0 kind control plane
  assert.match(r.log, /error: \[upgrade\/init config\] FATAL: this version of kubeadm only supports deploying clusters with the control plane version >= 1\.36\.0\. Current version: v1\.35\.0/);
  assert.match(r.log, /\[upgrade\] SUCCESS! A control plane node of your cluster was upgraded to "v1\.36\.1"\./);
  // After apply, the VERSION column (the kubelet) still said v1.35.0 on the real node.
  assert.match(r.log, /\$ kubectl get nodes\nNAME[^\n]*\nops-control-plane +Ready +control-plane +\S+ +v1\.35\.0/);
  assert.match(r.log, /Warning: version difference between client \(1\.37\) and server \(1\.35\) exceeds the supported minor version skew of \+\/-1/);
  assert.deepEqual(r.done, all(m), r.log);
  assert.ok(skew(r.st.ctx.ops).every((x) => x.ok));
  const lazy = play(m, script.filter((l) => typeof l !== 'string' || !/drain ops-worker/.test(l)));
  assert.equal(lazy.done[5], false);
  assert.match(m.steps[5].why!(lazy.st), /while web was still on ops-worker/);
});

test('kubeadm refuses a target newer than itself, with the real wording', () => {
  const c = ctx();
  // kubeadm 1.36.1: kubeadm upgrade apply v1.37.2 --dry-run on a 1.36.1 node
  assert.equal(c.k('docker exec ops-control-plane kubeadm upgrade apply v1.37.2 -y'), 'error: error execution phase preflight: the version argument is invalid due to these fatal errors:\n\n\t- Specified version to upgrade to "v1.37.2" is at least one minor release higher than the kubeadm minor release (37 > 36). Such an upgrade is not supported\n\nPlease fix the misalignments highlighted above and try upgrading again\nTo see the stack trace of this error execute with --v=5 or higher');
});

test('mission plays: quorum, and the quorum-loss message says plainly it is the sandbox\'s', () => {
  const m = OPS_MISSIONS['ops-quorum'];
  const flags = '--endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key';
  const r = play(m, [`kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl ${flags} member list -w table`, 'docker exec ops-control-plane3 mv /etc/kubernetes/manifests/etcd.yaml /tmp/', 2, 'kubectl get nodes',
    'docker exec ops-control-plane2 mv /etc/kubernetes/manifests/etcd.yaml /tmp/', 2, 'kubectl get nodes', 'docker exec ops-control-plane2 mv /tmp/etcd.yaml /etc/kubernetes/manifests/', 'docker exec ops-control-plane3 mv /tmp/etcd.yaml /etc/kubernetes/manifests/', 3, 'kubectl get nodes']);
  assert.match(r.log, /\|\s+ID\s+\|\s+STATUS\s+\|\s+NAME\s+\|\s+PEER ADDRS\s+\|\s+CLIENT ADDRS\s+\|\s+IS LEARNER\s+\|/);
  assert.match(NO_QUORUM, /^sandbox: /);
  assert.deepEqual(r.done, all(m), r.log);
});

test('mission plays: restore, including the API server\'s stale cache', () => {
  const m = OPS_MISSIONS['ops-restore'];
  const flags = '--endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key';
  const r = play(m, [`kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl ${flags} snapshot save /var/lib/etcd/snap.db`, 'kubectl create namespace after-snap',
    `kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl ${flags} snapshot restore /var/lib/etcd/snap.db --data-dir /var/lib/etcd/r2`,
    'kubectl -n kube-system exec etcd-ops-control-plane -- etcdutl --data-dir /var/lib/etcd/restored snapshot restore /var/lib/etcd/snap.db',
    'kubectl -n kube-system exec etcd-ops-control-plane -- etcdutl --data-dir /var/lib/etcd/restored snapshot restore /var/lib/etcd/snap.db',
    "docker exec ops-control-plane sed -i 's#path: /var/lib/etcd$#path: /var/lib/etcd/restored#' /etc/kubernetes/manifests/etcd.yaml", 3, 'kubectl get ns',
    'docker exec ops-control-plane mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/', 2, 'kubectl get ns', 'docker exec ops-control-plane mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/', 3, 'kubectl get ns']);
  // etcdctl 3.6.8 has no snapshot restore any more
  assert.match(r.log, /Error: unknown flag: --data-dir/);
  // etcdutl into a directory that exists
  assert.match(r.log, /Error: data-dir "\/var\/lib\/etcd\/restored" not empty or could not be read/);
  assert.match(r.log, /Snapshot saved at \/var\/lib\/etcd\/snap\.db\nServer version 3\.6\.0/);
  assert.match(r.log, /\$ kubectl get ns\nNAME +STATUS +AGE\nafter-snap +Active/);
  assert.match(r.log, new RegExp(API_DOWN));
  assert.ok(/\$ kubectl get ns\nNAME[^$]*$/.test(r.log) && !/after-snap/.test(r.log.slice(r.log.lastIndexOf('$ kubectl get ns'))));
  assert.deepEqual(r.done, all(m), r.log);
});

const ETCD = '--endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key';
const SAVE = `kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl ${ETCD} snapshot save /var/lib/etcd/snap.db`;
const RESTORE = 'kubectl -n kube-system exec etcd-ops-control-plane -- etcdutl --data-dir /var/lib/etcd/restored snapshot restore /var/lib/etcd/snap.db';
const POINT = "docker exec ops-control-plane sed -i 's#path: /var/lib/etcd$#path: /var/lib/etcd/restored#' /etc/kubernetes/manifests/etcd.yaml";
const API_OUT = 'docker exec ops-control-plane mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/';
const API_IN = 'docker exec ops-control-plane mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/';

// The original failure: after the restore mission, a namespace created on the
// restored etcd vanished at the next API server restart, because the
// snapshot's filter ran at every API server start instead of once, when etcd
// loaded the restored directory. A real restored etcd commits that write and
// keeps it.
test('a namespace created after a restore survives API server restarts (it used to vanish)', () => {
  const m = OPS_MISSIONS['ops-restore'];
  const r = play(m, [SAVE, 'kubectl create namespace after-snap', RESTORE, POINT, 3, 'kubectl get ns', API_OUT, 2, 'kubectl get ns', API_IN, 3, 'kubectl get ns']);
  assert.deepEqual(r.done, all(m), r.log);
  const k = (l: string) => text(opsRun(r.st, l));
  assert.equal(k('kubectl create namespace post-restore'), 'namespace/post-restore created');
  for (let round = 0; round < 3; round++) {
    k(API_OUT); r.st.ctx.ops.step(2); k(API_IN); r.st.ctx.ops.step(3);
    assert.match(k('kubectl get ns post-restore'), /^NAME +STATUS +AGE\npost-restore +Active/, `restart ${round + 1}`);
    assert.match(k('kubectl get ns after-snap'), /NotFound/);
  }
});

test('mission plays: restore in the docs\' order (API server stopped first), and a hand-deleted namespace does not pass', () => {
  const m = OPS_MISSIONS['ops-restore'];
  const r = play(m, [SAVE, 'kubectl create namespace after-snap', RESTORE, API_OUT, 2, POINT, 3, API_IN, 3, 'kubectl get ns']);
  // after-snap is gone at the first look: nothing was cached across the swap.
  assert.doesNotMatch(r.log.slice(r.log.lastIndexOf('$ kubectl get ns')), /after-snap/);
  assert.deepEqual(r.done, all(m), r.log);
  const bad = play(m, [SAVE, 'kubectl create namespace after-snap', 'kubectl delete ns after-snap', RESTORE, POINT, 3, 'kubectl get ns', API_OUT, 2, API_IN, 3, 'kubectl get ns']);
  assert.deepEqual(bad.done, [true, true, true, true, true, false], bad.log);
  assert.match(m.steps[5].why!(bad.st), /already gone before the restore/);
});

// The original failure: the worker step ticked with a 1.36.1 kubelet against a
// 1.35.0 API server, the worker's kubeadm never upgraded (the reviewer's run:
// steps read 000001, with a ✗ in the skew panel).
test('upgrade: the worker step never ticks in an unsupported skew', () => {
  const m = OPS_MISSIONS['ops-upgrade'];
  const r = play(m, ['kubectl drain ops-worker --ignore-daemonsets', 6, 'docker exec ops-worker kubeadm upgrade node', 'docker cp v1.36.1/kubelet ops-worker:/usr/bin/kubelet', 'docker exec ops-worker systemctl restart kubelet', 2, 'kubectl uncordon ops-worker', 2]);
  // kubeadm 1.35.0 on a 1.35.0 cluster has nothing to refuse: the skew is the kubelet's.
  assert.match(r.log, /kubelet configuration for this node was successfully upgraded/);
  assert.equal(r.st.latched.has('u6'), false);
  assert.equal(m.steps[5].done(r.st), false);
  assert.ok(r.st.ctx.ops.kubeletAhead.has('ops-worker'));
  // Upgrading the control plane afterwards does not launder the path that got there.
  const later = ['kubectl version', 'kubectl get nodes', 'docker cp v1.37.2/kubeadm ops-control-plane:/usr/bin/kubeadm', 'docker exec ops-control-plane kubeadm upgrade plan',
    'docker cp v1.36.1/kubeadm ops-control-plane:/usr/bin/kubeadm', 'docker exec ops-control-plane kubeadm upgrade apply v1.36.1 -y', 'kubectl get nodes',
    'kubectl drain ops-control-plane --ignore-daemonsets', 4, 'docker cp v1.36.1/kubelet ops-control-plane:/usr/bin/kubelet', 'docker exec ops-control-plane systemctl restart kubelet', 2, 'kubectl uncordon ops-control-plane', 2,
    'kubectl drain ops-worker --ignore-daemonsets', 6, 'docker cp v1.36.1/kubeadm ops-worker:/usr/bin/kubeadm', 'docker exec ops-worker kubeadm upgrade node', 'docker cp v1.36.1/kubelet ops-worker:/usr/bin/kubelet', 'docker exec ops-worker systemctl restart kubelet', 2, 'kubectl uncordon ops-worker', 2];
  for (const c of later) { if (typeof c === 'number') { for (let i = 0; i < c; i++) opsTick(r.st); } else opsRun(r.st, c); let ok = true; m.steps.map((x) => (ok = ok && x.done(r.st))); }
  assert.ok(skew(r.st.ctx.ops).every((x) => x.ok));
  assert.equal(m.steps[5].done(r.st), false);
  assert.match(m.steps[5].why!(r.st), /ran newer than the API server/);
});

test('upgrade: a control-plane kubelet upgraded before the control plane does not pass either', () => {
  const m = OPS_MISSIONS['ops-upgrade'];
  const r = play(m, ['kubectl version', 'kubectl get nodes', 'kubectl drain ops-control-plane --ignore-daemonsets', 4, 'docker cp v1.36.1/kubelet ops-control-plane:/usr/bin/kubelet', 'docker exec ops-control-plane systemctl restart kubelet', 2,
    'docker cp v1.37.2/kubeadm ops-control-plane:/usr/bin/kubeadm', 'docker exec ops-control-plane kubeadm upgrade plan', 'docker cp v1.36.1/kubeadm ops-control-plane:/usr/bin/kubeadm', 'docker exec ops-control-plane kubeadm upgrade apply v1.36.1 -y', 'kubectl get nodes', 'kubectl uncordon ops-control-plane', 2]);
  assert.deepEqual(r.done.slice(0, 5), [true, true, true, true, false], r.log);
  assert.match(m.steps[4].why!(r.st), /^The kubelet on ops-control-plane ran newer than the API server/);
});

test('upgrade: kubeadm upgrade node refuses a kubeadm that does not match the control plane, and labels its worker output', () => {
  const m = OPS_MISSIONS['ops-upgrade'];
  const st = m.setup();
  for (const c of ['docker cp v1.36.1/kubeadm ops-control-plane:/usr/bin/kubeadm', 'docker exec ops-control-plane kubeadm upgrade apply v1.36.1 -y']) opsRun(st, c);
  assert.match(text(opsRun(st, 'docker exec ops-worker kubeadm upgrade node')), /^sandbox: the kubeadm on ops-worker is v1\.35\.0 and the control plane is v1\.36\.1/);
  assert.equal(st.seen.has('kubeadm-node:ops-worker'), false);
  opsRun(st, 'docker cp v1.36.1/kubeadm ops-worker:/usr/bin/kubeadm');
  const out = opsRun(st, 'docker exec ops-worker kubeadm upgrade node');
  // The captured lines came from a control-plane node; on a worker the screen says so.
  assert.equal(out.at(-1)!.kind, 'dim');
  assert.match(out.at(-1)!.text, /captured on a control-plane node; no worker run was captured/);
  assert.ok(!opsRun(st, 'docker exec ops-control-plane kubeadm upgrade node').some((l) => l.kind === 'dim'));
});

test('pod IPs are valid and never shared (it used to print 10.244.0.-155)', () => {
  const c = ctx();
  c.k('kubectl create deployment hello --image=panda/hello:1.0 --replicas=4');
  c.k('kubectl create deployment web --image=panda/web:1.0 --replicas=3');
  c.ops.step(6);
  const out = c.k('kubectl get pods -A -o wide');
  const ips = [...out.matchAll(/ (10\.244\.(\d+)\.(-?\d+)) /g)];
  assert.equal(ips.length, 9, out);
  assert.equal(new Set(ips.map((m) => m[1])).size, 9, out);
  for (const m of ips) assert.ok(+m[3] >= 2 && +m[3] <= 254, m[1]);
});

test('drain --timeout takes Go durations, with Go\'s errors, before cordoning anything', () => {
  const c = ctx();
  // kubectl 1.37.2 drain no-such-node --dry-run=client --timeout=30 (and =abc), on tiltdev
  assert.equal(c.k('kubectl drain ops-worker --ignore-daemonsets --timeout=30'), 'error: invalid argument "30" for "--timeout" flag: time: missing unit in duration "30"\nSee \'kubectl drain --help\' for usage.');
  assert.equal(c.k('kubectl drain ops-worker --ignore-daemonsets --timeout=abc'), 'error: invalid argument "abc" for "--timeout" flag: time: invalid duration "abc"\nSee \'kubectl drain --help\' for usage.');
  assert.equal(c.ops.node('ops-worker')!.unschedulable, false, 'a bad --timeout cordons nothing');
  // Accepted for real: 1m30s, 2h, 90s and 1.5m all reached the API (NotFound for the node).
  for (const t of ['1m30s', '2h', '90s', '1.5m']) {
    assert.match(c.k(`kubectl drain ops-worker --ignore-daemonsets --timeout=${t}`), /^node\/ops-worker (already )?cordoned/, t);
    c.k('kubectl uncordon ops-worker');
  }
});

test('Go duration parsing and printing', () => {
  assert.deepEqual(['1m30s', '2h', '1.5m', '250ms', '0', '-5s', '1h2m3s'].map(goDuration), [90, 7200, 90, 0.25, 0, -5, 3723]);
  assert.throws(() => goDuration('5x'), /time: unknown unit "x" in duration "5x"/);
  assert.throws(() => goDuration(''), /time: invalid duration ""/);
  assert.deepEqual([20, 60, 90, 120, 3600, 3723, 1.5, 0.25].map(goDurationString), ['20s', '1m0s', '1m30s', '2m0s', '1h0m0s', '1h2m3s', '1.5s', '250ms']);
});

test('etcdctl snapshot status|restore <file>: the help and exit 0, as etcdctl 3.6.8 printed on tiltdev', () => {
  const c = ctx();
  const out = run(c, `kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl ${ETCD} snapshot status /var/lib/etcd/x.db`);
  assert.match(text(out), /^NAME:\n  snapshot - Manages etcd node snapshots/);
  assert.doesNotMatch(text(out), /Error|exit code/);
  // a flag the snapshot command lacks is what adds the error
  assert.match(c.k(`kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl ${ETCD} snapshot restore /var/lib/etcd/x.db --data-dir=/var/lib/etcd/r`), /\nError: unknown flag: --data-dir\ncommand terminated with exit code 1$/);
});

test('a NotReady node\'s pods: READY still 1/1, the Ready condition False, and describe node still lists them', () => {
  const c = ctx();
  c.k('kubectl create deployment hello --image=panda/hello:1.0 --replicas=4');
  c.k('kubectl run p --image=panda/hello:1.0');
  c.ops.step(6);
  // kubectl describe pod rwop-user on tiltdev (1.36.1): the block, trailing spaces and all
  assert.match(c.k('kubectl describe pod p'), /\nConditions:\n {2}Type {24}Status\n {2}PodReadyToStartContainers {3}True \n {2}Initialized {17}True \n {2}Ready {23}True \n {2}ContainersReady {13}True \n {2}PodScheduled {16}True \n/);
  const node = c.ops.pods.get('default/p')!.node!;
  c.k(`docker exec ${node} systemctl stop kubelet`);
  while (c.ops.node(node)!.ready) c.ops.step();
  c.ops.step();
  assert.match(c.k('kubectl get pods'), /^p +1\/1 +Running/m);
  assert.match(c.k('kubectl describe pod p'), /\n {2}Ready {23}False \n {2}ContainersReady {13}True \n/);
  // The node controller's marking reaches the Deployment's status too: fewer ready.
  assert.match(c.k('kubectl get deploy'), /^hello +[0-3]\/4/m);
  c.ops.step(62);
  assert.equal(c.ops.pods.get('default/p')!.status, 'Terminating');
  // describe node selects by phase, so the evicted pods still show up there.
  assert.match(c.k(`kubectl describe node ${node}`), /\n {2}default +p\n/);
  // The kubelet-return cleanup was never observed for real: the screen says so.
  const back = run(c, `docker exec ${node} systemctl start kubelet`);
  assert.equal(back.at(-1)!.kind, 'dim');
  assert.match(back.at(-1)!.text, /we could not watch it for real/);
});

test('the sandbox refuses what it does not model, by name', () => {
  const c = ctx();
  assert.match(c.k('kubectl get nodes | grep worker'), /^sandbox: "\|" needs a real shell/);
  assert.match(c.k('kubectl drain ops-worker --disable-eviction'), /^sandbox: --disable-eviction/);
  assert.match(c.k('kubectl get pvc'), /^sandbox: this ops sandbox does not model pvc/);
  assert.match(c.k('docker exec ops-worker rm -rf /'), /^sandbox: on the node/);
  assert.equal(c.k('kubectl -n kube-system delete pod kube-scheduler-ops-control-plane'), 'pod "kube-scheduler-ops-control-plane" deleted from kube-system namespace');
  c.ops.step(1);
  assert.ok(c.ops.pods.has('kube-system/kube-scheduler-ops-control-plane'), 'the kubelet posts the mirror pod again');
  assert.match(c.k('docker exec ops-control-plane kubeadm upgrade apply v1.36.1'), /cannot answer prompts/);
  // Real flags the sandbox lacks are its limit, never kubectl's "unknown flag".
  assert.match(c.k('kubectl --context kind-ops-lab get nodes'), /^sandbox: --context is real kubectl/);
  assert.match(c.k('kubectl get pods -l app=web'), /^sandbox: -l is a real kubectl flag/);
  assert.match(c.k('kubectl get nodes --bogus'), /^error: unknown flag: --bogus/);
  const rz = run(c, "kubectl get --raw '/readyz?verbose'");
  assert.match(rz.at(-1)!.text, /^\(sandbox: list trimmed/);
});
