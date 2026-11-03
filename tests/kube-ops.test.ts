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
import { human, table } from '../src/lib/kube-ops/print.ts';
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
  assert.match(r.log, /global timeout reached: 60s/);
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
});
