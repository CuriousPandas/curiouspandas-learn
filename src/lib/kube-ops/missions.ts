// Missions for the ops sandbox. They judge state and what the learner looked
// at, never the words typed, and each step latches once true: later steps
// change the state earlier ones looked at (the scheduler comes back, the node
// becomes Ready again), and the checklist re-judges every step on every tick.

import type { Mission } from '../missions.ts';
import { Ops } from './ops.ts';
import { run, tickJobs, interrupt, type Ctx } from './kubectl.ts';
import type { Out } from './print.ts';

export type OpsState = { ctx: Ctx; history: string[]; seen: Set<string>; latched: Set<string> };

function setup(make: () => Ops, lines: string[], warm: number, after?: (o: Ops) => void): () => OpsState {
  return () => {
    const seen = new Set<string>();
    const st: OpsState = { ctx: { ops: make(), jobs: [], seen: (w) => seen.add(w) }, history: [], seen, latched: new Set() };
    for (const l of lines) run(st.ctx, l);
    st.ctx.ops.step(warm);
    after?.(st.ctx.ops);
    seen.clear();
    return st;
  };
}

/** Run one command. A drain still running is interrupted first, as Ctrl+C would. */
export function opsRun(st: OpsState, line: string): Out[] {
  const stopped = interrupt(st.ctx);
  st.history.push(line);
  return [...stopped, ...run(st.ctx, line)];
}

/** One tick of time, returning any lines a running drain printed. */
export function opsTick(st: OpsState): Out[] {
  st.ctx.ops.step();
  return tickJobs(st.ctx);
}

const latch = (id: string, cond: (s: OpsState) => boolean) => (s: OpsState) => {
  if (s.latched.has(id)) return true;
  if (cond(s)) { s.latched.add(id); return true; }
  return false;
};
const has = (s: OpsState, w: string) => s.seen.has(w);
const some = (s: OpsState, re: RegExp) => [...s.seen].some((w) => re.test(w));
const pod = (o: Ops, ns: string, name: string) => o.pods.get(`${ns}/${name}`);
const appPods = (o: Ops, app: string) => [...o.pods.values()].filter((p) => p.app === app && p.ns === 'default');

// ---- control-plane: Pending, and no event says why --------------------------------

export const CONTROL_PLANE_MISSION: Mission<OpsState> = {
  id: 'ops-control-plane', title: 'Pending, and no event says why', xp: 70,
  setup: setup(() => new Ops(), ['kubectl create deployment hello --image=panda/hello:1.0 --replicas=2'], 4, (o) => {
    // Someone's maintenance, half finished: the scheduler's manifest moved aside.
    const cp = o.nodes[0];
    cp.manifests.delete('kube-scheduler.yaml'); cp.tmp.add('kube-scheduler.yaml');
    o.step(2);
    run({ ops: o, jobs: [], seen: () => {} }, 'kubectl run p --image=panda/hello:1.0');
    o.step(4);
  }),
  steps: [
    { text: 'p is Pending. Describe it and read its Events', hint: 'kubectl describe pod p', done: latch('c1', (s) => some(s, /^described-unscheduled:p:0$/)) },
    { text: 'List the control plane\'s own pods. Which one is missing?', hint: 'kubectl -n kube-system get pods', done: latch('c2', (s) => has(s, 'get:pod') && s.history.some((l) => /kube-system|-A\b|--all-namespaces/.test(l))) },
    { text: 'Look in the directory the kubelet runs them from', hint: 'docker exec ops-control-plane ls /etc/kubernetes/manifests', done: latch('c3', (s) => some(s, /^ls-manifests:ops-control-plane:/)) },
    { text: 'Put the scheduler back and get p Running', hint: 'docker exec ops-control-plane mv /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/', done: latch('c4', (s) => pod(s.ctx.ops, 'default', 'p')?.status === 'Running') },
    { text: 'Now stop the controller-manager yourself, the same way', hint: 'docker exec ops-control-plane mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/', done: latch('c5', (s) => !s.ctx.ops.nodes[0].containers.has('kube-controller-manager')) },
    {
      text: 'Delete a hello pod. Is it replaced? Then ask the Deployment how many are ready',
      hint: 'kubectl get pods  then  kubectl delete pod <a hello pod>  then  kubectl get deploy',
      done: latch('c6', (s) => has(s, 'saw-stale-deploy')),
      why: (s) => has(s, 'deleted-pod:hello') && !s.ctx.ops.nodes[0].containers.has('kube-controller-manager') ? 'Once the pod is gone, kubectl get deploy shows what the Deployment last wrote down.' : '',
    },
    { text: 'Put the controller-manager back and watch hello heal', hint: 'docker exec ops-control-plane mv /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/', done: latch('c7', (s) => s.ctx.ops.running('kube-controller-manager') && appPods(s.ctx.ops, 'hello').filter((p) => p.ready).length === 2) },
  ],
  debrief: 'With the scheduler stopped, p had no events at all, because the scheduler is what writes FailedScheduling. Silence was the clue. With the controller-manager stopped, nothing replaced the deleted pod, and the Deployment still said 2/2 ready: status is written by the controllers, so it goes stale with them. Both ran as static pods, from files the kubelet watches, which is why moving a file stopped them and moving it back healed the cluster.',
};

// ---- node-troubleshooting: NotReady, and the pods left five minutes later ------------

export const NODE_MISSION: Mission<OpsState> = {
  id: 'ops-node', title: 'NotReady, and the pods left five minutes later', xp: 80,
  setup: setup(() => new Ops(), ['kubectl create deployment hello --image=panda/hello:1.0 --replicas=4', 'kubectl run p --image=panda/hello:1.0'], 6),
  steps: [
    { text: 'Stop the kubelet on ops-worker', hint: 'docker exec ops-worker systemctl stop kubelet', done: latch('n1', (s) => has(s, 'kubelet-stopped:ops-worker')) },
    { text: 'Watch the nodes until ops-worker is NotReady. How long did it take?', hint: 'kubectl get nodes  (again and again)', done: latch('n2', (s) => has(s, 'saw-notready:ops-worker')) },
    { text: 'Describe ops-worker: read its conditions and its taints', hint: 'kubectl describe node ops-worker', done: latch('n3', (s) => has(s, 'described-notready:ops-worker')) },
    { text: 'List the pods with their nodes. What do the ones on ops-worker claim?', hint: 'kubectl get pods -o wide', done: latch('n4', (s) => has(s, 'saw-stale-running')) },
    { text: 'Wait for the eviction (five minutes of cluster time), then look again', hint: 'kubectl get pods -o wide', done: latch('n5', (s) => has(s, 'saw-evicted')) },
    { text: 'Read the node\'s own log for why it went quiet', hint: 'docker exec ops-worker journalctl -u kubelet', done: latch('n6', (s) => has(s, 'journal:ops-worker:false')) },
    { text: 'Start the kubelet and get ops-worker Ready', hint: 'docker exec ops-worker systemctl start kubelet', done: latch('n7', (s) => !!s.ctx.ops.node('ops-worker')?.ready && s.latched.has('n5')) },
  ],
  debrief: 'NotReady came about 50 seconds after the kubelet stopped (the node-monitor grace period), and the pods there went on saying Running, because the kubelet that updates them was the thing that stopped. Five minutes later the default toleration ran out: hello\'s pods were replaced elsewhere, and p, a pod with no controller, was simply gone. On the real cluster the old containers were still running on the node the whole time. Nobody had told them.',
};

// ---- drain-and-disruption: the drain that never finished ------------------------

export const DRAIN_MISSION: Mission<OpsState> = {
  id: 'ops-drain', title: 'The drain that never finished', xp: 80,
  setup: setup(() => new Ops(), ['kubectl create deployment web --image=panda/web:1.0 --replicas=2', 'kubectl create pdb web --selector=app=web --min-available=2'], 6),
  steps: [
    { text: 'Read the budget: how many disruptions does it allow right now?', hint: 'kubectl get pdb', done: latch('d1', (s) => has(s, 'get:pdb')) },
    { text: 'Drain ops-worker, with a 60 second timeout', hint: 'kubectl drain ops-worker --ignore-daemonsets --timeout=60s', done: latch('d2', (s) => has(s, 'drain-blocked')) },
    { text: 'The drain failed. Is ops-worker still taking new pods?', hint: 'kubectl get nodes', done: latch('d3', (s) => s.latched.has('d2') && has(s, 'get:node') && !!s.ctx.ops.node('ops-worker')?.unschedulable) },
    {
      text: 'Let one web pod go at a time, and keep the budget',
      hint: `kubectl patch pdb web -p '{"spec":{"minAvailable":1}}'`,
      done: latch('d4', (s) => { const b = s.ctx.ops.pdbs.get('default/web'); return !!b && b.status.allowed >= 1; }),
      why: (s) => !s.ctx.ops.pdbs.has('default/web') ? 'The budget is gone, so nothing protects web during the next drain either. Put one back: kubectl create pdb web --selector=app=web --min-available=1' : '',
    },
    { text: 'Drain ops-worker again, and let it finish', hint: 'kubectl drain ops-worker --ignore-daemonsets --timeout=120s', done: latch('d5', (s) => has(s, 'drained:ops-worker') && s.ctx.ops.pdbs.has('default/web')) },
    { text: 'Maintenance done: let ops-worker take pods again', hint: 'kubectl uncordon ops-worker', done: latch('d6', (s) => s.latched.has('d5') && !s.ctx.ops.node('ops-worker')?.unschedulable) },
  ],
  debrief: 'A budget of minAvailable 2 for 2 replicas allows zero disruptions, so every eviction got the API\'s refusal and drain retried every 5 seconds until its timeout. Without --timeout it would retry for ever. The failed drain left the node cordoned. minAvailable 1 let one pod go, wait for its replacement to be Ready on ops-worker2, then let the next go. Deleting the budget would also have "worked", and left web unprotected.',
};

// ---- upgrades: you can't skip a minor version --------------------------------

function upgradeWorld() {
  const o = new Ops({ workers: 1, version: 'v1.35.0' });
  o.hostFiles.set('v1.37.2/kubeadm', { what: 'kubeadm', version: 'v1.37.2' });
  o.hostFiles.set('v1.36.1/kubeadm', { what: 'kubeadm', version: 'v1.36.1' });
  o.hostFiles.set('v1.36.1/kubelet', { what: 'kubelet', version: 'v1.36.1' });
  return o;
}
const kubeletDone = (o: Ops, name: string) => { const n = o.node(name); return !!n && n.kubelet.version === 'v1.36.1' && !!n.drainedWhenReplaced && !n.unschedulable && n.ready; };

export const UPGRADE_MISSION: Mission<OpsState> = {
  id: 'ops-upgrade', title: 'You can\'t skip a minor version', xp: 90,
  setup: setup(upgradeWorld, ['kubectl create deployment web --image=panda/web:1.0 --replicas=2'], 6),
  steps: [
    { text: 'Read the versions: the server\'s, and each node\'s', hint: 'kubectl version  then  kubectl get nodes', done: latch('u1', (s) => has(s, 'version') && has(s, 'get:node')) },
    { text: 'Try the leap: put kubeadm 1.37.2 on the control plane and plan an upgrade', hint: 'docker cp v1.37.2/kubeadm ops-control-plane:/usr/bin/kubeadm  then  docker exec ops-control-plane kubeadm upgrade plan', done: latch('u2', (s) => has(s, 'kubeadm-refused-skip')) },
    { text: 'Upgrade the control plane to 1.36.1 instead', hint: 'docker cp v1.36.1/kubeadm ops-control-plane:/usr/bin/kubeadm  then  docker exec ops-control-plane kubeadm upgrade apply v1.36.1 -y', done: latch('u3', (s) => has(s, 'control-plane-upgraded')) },
    { text: 'Look at the VERSION column again. Why does it still say 1.35?', hint: 'kubectl get nodes', done: latch('u4', (s) => s.latched.has('u3') && has(s, 'get:node')) },
    {
      text: 'Upgrade the control plane\'s kubelet: drain, replace, restart, uncordon',
      hint: 'kubectl drain ops-control-plane --ignore-daemonsets  then  docker cp v1.36.1/kubelet ops-control-plane:/usr/bin/kubelet  then  docker exec ops-control-plane systemctl restart kubelet  then  kubectl uncordon ops-control-plane',
      done: latch('u5', (s) => kubeletDone(s.ctx.ops, 'ops-control-plane')),
      why: (s) => { const n = s.ctx.ops.node('ops-control-plane'); return n && n.kubeletBinary === 'v1.36.1' && !n.drainedWhenReplaced ? 'The new kubelet went in while pods were still on the node. The docs say drain first for a minor upgrade: drain, copy it in again, restart.' : ''; },
    },
    {
      text: 'Upgrade ops-worker: drain, kubeadm upgrade node, kubelet, restart, uncordon',
      hint: 'kubectl drain ops-worker --ignore-daemonsets  then  docker cp v1.36.1/kubeadm ops-worker:/usr/bin/kubeadm  then  docker exec ops-worker kubeadm upgrade node  then  docker cp v1.36.1/kubelet ops-worker:/usr/bin/kubelet  then  docker exec ops-worker systemctl restart kubelet  then  kubectl uncordon ops-worker',
      done: latch('u6', (s) => has(s, 'kubeadm-node:ops-worker') && kubeletDone(s.ctx.ops, 'ops-worker')),
      why: (s) => { const n = s.ctx.ops.node('ops-worker'); if (n && n.kubeletBinary === 'v1.36.1' && !n.drainedWhenReplaced) return 'The new kubelet went in while web was still on ops-worker. Drain it, copy the kubelet in again, restart.'; if (n?.kubelet.version === 'v1.36.1' && !has(s, 'kubeadm-node:ops-worker')) return 'Run kubeadm upgrade node on ops-worker too: it upgrades the node\'s kubelet configuration.'; return ''; },
    },
  ],
  debrief: 'kubeadm refused the leap before touching anything: one minor version at a time is a rule it enforces, not advice. The control plane went first, and the VERSION column, which is each node\'s kubelet, lagged until each node was drained and its kubelet replaced. Every step on the way kept a supported skew: kubelets never newer than the API server, never more than three minors behind.',
};

// ---- etcd: quorum, then snapshot and restore ---------------------------------------

export const QUORUM_MISSION: Mission<OpsState> = {
  id: 'ops-quorum', title: 'Two of three, never two of four', xp: 60,
  setup: setup(() => new Ops({ controlPlanes: 3, workers: 1 }), [], 4),
  steps: [
    { text: 'List the etcd members', hint: 'kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl --endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key member list -w table', done: latch('q1', (s) => has(s, 'etcd-member-list')) },
    { text: 'Stop one member (move its manifest aside on ops-control-plane3). Does the API still answer?', hint: 'docker exec ops-control-plane3 mv /etc/kubernetes/manifests/etcd.yaml /tmp/  then  kubectl get nodes', done: latch('q2', (s) => s.ctx.ops.etcdUp().length === 2 && has(s, 'get:node')) },
    { text: 'Stop a second member, on ops-control-plane2. Try kubectl now', hint: 'docker exec ops-control-plane2 mv /etc/kubernetes/manifests/etcd.yaml /tmp/  then  kubectl get nodes', done: latch('q3', (s) => s.ctx.ops.etcdUp().length === 1 && has(s, 'api-no-quorum')) },
    { text: 'Bring both back and check the cluster answers', hint: 'docker exec ops-control-plane2 mv /tmp/etcd.yaml /etc/kubernetes/manifests/  then  the same on ops-control-plane3  then  kubectl get nodes', done: latch('q4', (s) => s.latched.has('q3') && s.ctx.ops.etcdUp().length === 3 && s.ctx.ops.api() === 'ok' && has(s, 'get:node')) },
  ],
  debrief: 'Three members need two to agree, so losing one cost nothing you could see, and losing two left etcd unable to agree on anything: no write could be saved, and the sandbox answers nothing. A fourth member would not have helped: four need three, so four also survive only one loss. That is the whole case for odd numbers.',
};

export const RESTORE_MISSION: Mission<OpsState> = {
  id: 'ops-restore', title: 'Restore, and the namespace that would not leave', xp: 80,
  setup: setup(() => new Ops({ workers: 0 }), ['kubectl create namespace before-snap'], 4),
  steps: [
    { text: 'Save a snapshot of etcd, to /var/lib/etcd/snap.db', hint: 'kubectl -n kube-system exec etcd-ops-control-plane -- etcdctl --endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key snapshot save /var/lib/etcd/snap.db', done: latch('r1', (s) => has(s, 'etcd-snapshot')) },
    { text: 'Create a namespace called after-snap: something the snapshot does not have', hint: 'kubectl create namespace after-snap', done: latch('r2', (s) => s.latched.has('r1') && has(s, 'created-ns:after-snap')) },
    { text: 'Restore the snapshot into a new directory', hint: 'kubectl -n kube-system exec etcd-ops-control-plane -- etcdutl --data-dir /var/lib/etcd/restored snapshot restore /var/lib/etcd/snap.db', done: latch('r3', (s) => has(s, 'etcd-restored')) },
    { text: 'Point etcd\'s manifest at that directory, and wait for the API to come back', hint: "docker exec ops-control-plane sed -i 's#path: /var/lib/etcd$#path: /var/lib/etcd/restored#' /etc/kubernetes/manifests/etcd.yaml  then  kubectl get ns", done: latch('r4', (s) => has(s, 'etcd-manifest-pointed') && s.ctx.ops.api() === 'ok' && has(s, 'get:ns')) },
    { text: 'Is after-snap gone? Look', hint: 'kubectl get ns', done: latch('r5', (s) => s.latched.has('r4') && has(s, 'get-ns:after-snap:true')) },
    { text: 'Restart the API server (move its manifest out and back) and look again', hint: 'docker exec ops-control-plane mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/  then  wait  then  docker exec ops-control-plane mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/  then  kubectl get ns', done: latch('r6', (s) => s.latched.has('r5') && has(s, 'get-ns:after-snap:false')) },
  ],
  debrief: 'etcd was serving the snapshot as soon as it restarted, but the API server still answered from what it had cached, so after-snap looked alive. The docs say to stop every API server before a restore and start them after, and now you have seen why. The snapshot itself lived on the node\'s disk: delete the cluster and it goes too, which is the backups-that-restore lesson in Kubernetes form.',
};

export const OPS_MISSIONS: Record<string, Mission<OpsState>> = Object.fromEntries(
  [CONTROL_PLANE_MISSION, NODE_MISSION, DRAIN_MISSION, UPGRADE_MISSION, QUORUM_MISSION, RESTORE_MISSION].map((m) => [m.id, m]));
