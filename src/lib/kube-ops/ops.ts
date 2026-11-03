// A toy cluster for cluster operations: control-plane components that can be
// stopped, kubelets with heartbeats, the node-lifecycle controller, cordon,
// drain and PodDisruptionBudgets, component versions, and etcd members with a
// quorum, snapshots and restores. It is shaped like a kind cluster called
// "ops", because kind is where every behaviour here was reproduced while the
// lessons were written (Kubernetes 1.36.1 nodes, kubectl 1.37.2).
//
// The one rule the model leans on most: the kubelet runs containers, it is not
// them. Stopping a kubelet stops nobody's process, static control-plane pods
// included. That is why a stopped scheduler is done by moving its manifest,
// and why pods on a node whose kubelet died keep running after Kubernetes has
// "evicted" them.

import { record, suffixer, type Ev } from './print.ts';

export const SECONDS_PER_TICK = 5;
/** kube-controller-manager --node-monitor-grace-period, default 50s (reference page, fetched 2026-11-03). */
export const GRACE_TICKS = 10;
/** The default tolerationSeconds=300 for not-ready and unreachable, added to every pod that does not set its own. */
export const EVICT_TICKS = 60;
/** The kubelet posts node status every 10s by default. */
const BEAT_TICKS = 2;

export const COMPONENTS = ['etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler'] as const;
export type Component = (typeof COMPONENTS)[number];

export type Taint = { key: string; effect: 'NoSchedule' | 'NoExecute'; added: number };

export type Node = {
  name: string; controlPlane: boolean;
  kubelet: { running: boolean; version: string };
  /** The kubelet binary on disk. A copied-in binary takes effect at the next (re)start. */
  kubeletBinary: string; kubeadm: string;
  lastBeat: number; ready: boolean; notReadySince?: number;
  taints: Taint[]; unschedulable: boolean;
  manifests: Set<string>; tmp: Set<string>;
  /** Static containers actually running; changes only when a running kubelet syncs. */
  containers: Set<Component>; componentVersion: string;
  journal: string[]; events: Ev[];
  /** The kubelet was last replaced while this node had no workload pods on it. */
  drainedWhenReplaced?: boolean;
  etcdDataDir: string;
};

export type PodStatus = 'Pending' | 'ContainerCreating' | 'Running' | 'Terminating';

export type Pod = {
  name: string; ns: string; app: string; image: string; node?: string;
  owner: { kind: 'ReplicaSet' | 'DaemonSet' | 'Node' | 'none'; name: string };
  status: PodStatus;
  /** What the kubelet last reported for the container: the READY column. */
  ready: boolean;
  created: number; startAt?: number; deleting?: number;
  events: Ev[]; component?: Component;
  /** The node controller set this pod's Ready condition False when its node went NotReady (MarkPodsNotReady). */
  markedNotReady?: boolean;
  /** Allocated once, when the pod lands on a node. */
  ip?: string;
};

export type Deployment = { name: string; ns: string; replicas: number; image: string; hash: string; created: number;
  /** What `kubectl get deploy` shows: written by the deployment controller, so stale when it is down. */
  status: { ready: number; upToDate: number; available: number } };

export type Pdb = { name: string; ns: string; app: string; minAvailable?: number | string; maxUnavailable?: number | string; created: number;
  /** Written by the disruption controller in kube-controller-manager. */
  status: { allowed: number; current: number; desired: number; total: number } };

export type Snapshot = { path: string; node: string; revision: number; namespaces: string[]; pods: string[]; nsCreated: [string, number][] };

export class Ops {
  tick = 0;
  nodes: Node[] = [];
  pods = new Map<string, Pod>();
  deployments = new Map<string, Deployment>();
  pdbs = new Map<string, Pdb>();
  namespaces = new Map<string, number>();
  /** Files on each node's disk outside the manifests, for etcd snapshots and restores. */
  snapshots: Snapshot[] = [];
  restoredDirs = new Map<string, Snapshot>();
  /** The API server's watch cache: what it last read from etcd. Survives an etcd restore until it restarts. */
  cache: { namespaces: string[] } | null = null;
  /**
   * etcd's own data, as distinct from the cache: `namespaces` above is what
   * etcd holds. This is the data directory etcd last loaded it from, so a
   * restore replaces etcd's contents exactly once, at the moment etcd starts
   * on the restored directory.
   */
  etcdLoaded = '/var/lib/etcd';
  /** etcd's data was swapped under a running API server: its cache is stale until it restarts. */
  cacheStale = false;
  /** Namespaces the last restore removed from etcd (the mission checks it was the restore that did it). */
  droppedByRestore: string[] = [];
  /** Nodes whose running kubelet was ever newer than the API server: a skew the policy never supports. */
  kubeletAhead = new Set<string>();
  private nextIP = new Map<string, number>();
  etcdRevision = 2000;
  /** Revisions per apiserver container: a restart drops the cache. */
  private rand = suffixer(7);
  serverVersion: string;
  /** For the version-skew panel: the client kubectl. */
  clientVersion = 'v1.37.2';
  /** Host files the learner can `docker cp` onto a node, as downloaded from dl.k8s.io. */
  hostFiles = new Map<string, { what: 'kubeadm' | 'kubelet'; version: string }>();

  constructor(opts: { controlPlanes?: number; workers?: number; version?: string } = {}) {
    const v = opts.version ?? 'v1.36.1';
    this.serverVersion = v;
    const cps = opts.controlPlanes ?? 1, ws = opts.workers ?? 2;
    for (let i = 0; i < cps; i++) this.nodes.push(this.makeNode(`ops-control-plane${i ? i + 1 : ''}`, true, v));
    for (let i = 0; i < ws; i++) this.nodes.push(this.makeNode(`ops-worker${i ? i + 1 : ''}`, false, v));
    for (const n of ['default', 'kube-node-lease', 'kube-public', 'kube-system', 'local-path-storage']) this.namespaces.set(n, -360);
    // What every kind node runs: kindnet and kube-proxy as DaemonSets, two
    // CoreDNS replicas, which kind places on the control plane.
    for (const n of this.nodes) for (const ds of ['kindnet', 'kube-proxy']) this.addPod({ name: `${ds}-${this.rand(5)}`, ns: 'kube-system', app: ds, image: ds, node: n.name, owner: { kind: 'DaemonSet', name: ds }, running: true });
    for (let i = 0; i < 2; i++) this.addPod({ name: `coredns-668d6bf9bc-${this.rand(5)}`, ns: 'kube-system', app: 'coredns', image: 'coredns', node: this.nodes[0].name, owner: { kind: 'ReplicaSet', name: 'coredns-668d6bf9bc' }, running: true });
    this.deployments.set('kube-system/coredns', { name: 'coredns', ns: 'kube-system', replicas: 2, image: 'coredns', hash: '668d6bf9bc', created: -360, status: { ready: 2, upToDate: 2, available: 2 } });
    for (const n of this.nodes) for (const c of n.containers) this.pods.set(`kube-system/${c}-${n.name}`, { name: `${c}-${n.name}`, ns: 'kube-system', app: c, image: c, node: n.name, owner: { kind: 'Node', name: n.name }, status: 'Running', ready: true, created: -360, events: [], component: c });
    this.syncCache();
  }

  private makeNode(name: string, cp: boolean, v: string): Node {
    return {
      name, controlPlane: cp, kubelet: { running: true, version: v }, kubeletBinary: v, kubeadm: v, lastBeat: 0, ready: true,
      taints: cp ? [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule', added: -360 }] : [], unschedulable: false,
      manifests: new Set(cp ? COMPONENTS.map((c) => `${c}.yaml`) : []), tmp: new Set(), containers: new Set(cp ? COMPONENTS : []), componentVersion: v,
      journal: [], events: [], etcdDataDir: '/var/lib/etcd',
    };
  }

  node(name: string) { return this.nodes.find((n) => n.name === name); }
  get seconds() { return this.tick * SECONDS_PER_TICK; }

  addPod(p: { name: string; ns: string; app: string; image: string; node?: string; owner: Pod['owner']; running?: boolean; component?: Component }) {
    const pod: Pod = { ...p, status: p.running ? 'Running' : 'Pending', ready: !!p.running, created: p.running ? -360 : this.tick, events: [] };
    this.pods.set(`${p.ns}/${p.name}`, pod);
    return pod;
  }

  // ---- what is up --------------------------------------------------------

  etcdMembers() { return this.nodes.filter((n) => n.controlPlane); }
  etcdUp() { return this.etcdMembers().filter((n) => n.containers.has('etcd')); }
  /** (n/2)+1, the etcd FAQ's quorum. */
  quorum() { return Math.floor(this.etcdMembers().length / 2) + 1; }
  hasQuorum() { return this.etcdUp().length >= this.quorum(); }
  apiservers() { return this.nodes.filter((n) => n.containers.has('kube-apiserver')); }
  /** 'down' when no API server process is listening; 'no-quorum' when one is, but etcd cannot commit. */
  api(): 'ok' | 'down' | 'no-quorum' {
    if (!this.apiservers().length) return 'down';
    return this.hasQuorum() ? 'ok' : 'no-quorum';
  }
  running(c: Component) { return this.api() === 'ok' && this.nodes.some((n) => n.containers.has(c)); }

  // ---- the loops -----------------------------------------------------------

  step(n = 1) { for (let i = 0; i < n; i++) { this.once(); this.noteSkew(); } }

  private once() {
    this.tick++;
    const t = this.tick;
    const apiOk = this.api() === 'ok';

    // kubelets: sync static pods from their manifests, heartbeat, run pods.
    for (const n of this.nodes) {
      if (!n.kubelet.running) continue;
      for (const c of COMPONENTS) {
        const want = n.manifests.has(`${c}.yaml`);
        if (want && !n.containers.has(c)) {
          n.containers.add(c);
          if (c === 'kube-apiserver') { this.cache = null; this.cacheStale = false; }
          if (c === 'etcd' && n === this.nodes[0] && n.etcdDataDir !== this.etcdLoaded) this.loadDataDir(n.etcdDataDir);
        }
        if (!want) n.containers.delete(c);
      }
      if (!apiOk) continue;
      if (t % BEAT_TICKS === 0 || !n.ready) n.lastBeat = t;
      if (!n.ready) {
        n.ready = true; n.notReadySince = undefined;
        n.taints = n.taints.filter((x) => !x.key.startsWith('node.kubernetes.io/'));
        // The kubelet reports its pods again, Ready condition included.
        for (const p of this.pods.values()) if (p.node === n.name) p.markedNotReady = false;
        record(n.events, t, 'Normal', 'NodeReady', 'kubelet', `Node ${n.name} status is now: NodeReady`);
      }
      for (const p of this.pods.values()) {
        if (p.node !== n.name) continue;
        // An evicted pod (deleting = Infinity) waits for a kubelet to confirm it
        // stopped. Not observed for real: the kubelet we stopped could not start
        // again on that machine (inotify), so this is the documented behaviour.
        if (p.deleting !== undefined) { if (p.deleting === Infinity || t >= p.deleting) this.pods.delete(`${p.ns}/${p.name}`); continue; }
        if (p.status === 'ContainerCreating' && t >= (p.startAt ?? t)) {
          p.status = 'Running'; p.ready = true;
          record(p.events, t, 'Normal', 'Started', 'kubelet', 'spec.containers{app}: Container started');
        }
      }
    }
    if (!apiOk) return;
    this.syncCache();

    // Mirror pods: the API's view of each node's static containers.
    for (const n of this.nodes) for (const c of COMPONENTS) {
      const key = `kube-system/${c}-${n.name}`;
      const has = n.containers.has(c);
      if (has && !this.pods.has(key) && n.kubelet.running) this.pods.set(key, { name: `${c}-${n.name}`, ns: 'kube-system', app: c, image: c, node: n.name, owner: { kind: 'Node', name: n.name }, status: 'Running', ready: true, created: t, events: [], component: c });
      if (!has && this.pods.has(key) && n.kubelet.running) this.pods.delete(key);
    }

    const kcm = this.running('kube-controller-manager');
    if (kcm) this.nodeLifecycle(t);
    if (kcm) this.replicaSets(t);
    if (kcm) this.disruption();
    if (this.running('kube-scheduler')) this.schedule(t);
  }

  private nodeLifecycle(t: number) {
    for (const n of this.nodes) {
      if (n.ready && t - n.lastBeat > GRACE_TICKS) {
        n.ready = false; n.notReadySince = t;
        n.taints.push({ key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule', added: t }, { key: 'node.kubernetes.io/unreachable', effect: 'NoExecute', added: t });
        record(n.events, t, 'Normal', 'NodeNotReady', 'node-controller', `Node ${n.name} status is now: NodeNotReady`);
        // MarkPodsNotReady (pkg/controller/util/node, release-1.36): the Ready
        // condition goes False and this event is recorded. That takes the pods
        // out of Service endpoints and PDB health now, at ~50 s, not at eviction.
        for (const p of this.pods.values()) if (p.node === n.name && p.owner.kind !== 'Node') {
          p.markedNotReady = true;
          record(p.events, t, 'Warning', 'NodeNotReady', 'node-controller', 'Node is not ready');
        }
      }
      if (!n.ready && n.notReadySince !== undefined && t - n.notReadySince >= EVICT_TICKS) {
        // DaemonSet pods tolerate unreachable for ever, and mirror pods are not the API's to evict.
        for (const p of this.pods.values()) if (p.node === n.name && p.deleting === undefined && (p.owner.kind === 'ReplicaSet' || p.owner.kind === 'none')) {
          p.deleting = Infinity; p.status = 'Terminating';
          record(p.events, t, 'Normal', 'TaintManagerEviction', 'taint-eviction-controller', `Marking for deletion Pod ${p.ns}/${p.name}`);
        }
      }
    }
  }

  private replicaSets(t: number) {
    for (const d of this.deployments.values()) {
      const mine = [...this.pods.values()].filter((p) => p.ns === d.ns && p.owner.kind === 'ReplicaSet' && p.owner.name === `${d.name}-${d.hash}`);
      const live = mine.filter((p) => p.deleting === undefined);
      for (let i = live.length; i < d.replicas; i++) this.addPod({ name: `${d.name}-${d.hash}-${this.rand(5)}`, ns: d.ns, app: d.name, image: d.image, owner: { kind: 'ReplicaSet', name: `${d.name}-${d.hash}` } });
      for (const p of live.slice(d.replicas)) this.deletePod(p);
      const ready = mine.filter((p) => this.podReady(p) && p.deleting === undefined).length;
      d.status = { ready, upToDate: Math.min(d.replicas, live.length), available: ready };
      void t;
    }
  }

  /** The disruption controller: how many of a budget's pods may go right now. */
  private disruption() {
    for (const b of this.pdbs.values()) {
      const pods = [...this.pods.values()].filter((p) => p.ns === b.ns && p.app === b.app && p.deleting === undefined);
      const healthy = pods.filter((p) => this.podReady(p) && p.status === 'Running').length;
      const expected = this.deployments.get(`${b.ns}/${b.app}`)?.replicas ?? pods.length;
      const resolve = (v: number | string) => typeof v === 'number' ? v : Math.ceil((parseInt(v, 10) / 100) * expected);
      const desired = b.minAvailable !== undefined ? resolve(b.minAvailable) : Math.max(0, expected - resolve(b.maxUnavailable ?? 0));
      b.status = { allowed: Math.max(0, healthy - desired), current: healthy, desired, total: expected };
    }
  }

  private fits(p: Pod, n: Node) {
    if (n.unschedulable || !n.ready) return false;
    const tolerates = p.ns === 'kube-system' && p.app === 'coredns';
    return n.taints.every((x) => x.effect !== 'NoSchedule' || (tolerates && x.key === 'node-role.kubernetes.io/control-plane'));
  }

  private schedule(t: number) {
    for (const p of this.pods.values()) {
      if (p.node || p.deleting !== undefined) continue;
      const fit = this.nodes.filter((n) => this.fits(p, n));
      if (!fit.length) {
        // The scheduler's own wording, from a cordoned node and from a tainted
        // one on kind 1.36.1: reasons counted, sorted, then the preemption note.
        const counts = new Map<string, number>();
        for (const n of this.nodes) {
          const w = n.unschedulable ? 'node(s) were unschedulable' : 'node(s) had untolerated taint(s)';
          counts.set(w, (counts.get(w) ?? 0) + 1);
        }
        const msg = [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([w, c]) => `${c} ${w}`).join(', ');
        const N = this.nodes.length;
        record(p.events, t, 'Warning', 'FailedScheduling', 'default-scheduler', `0/${N} nodes are available: ${msg}. no new claims to deallocate, preemption: 0/${N} nodes are available: ${N} Preemption is not helpful for scheduling.`);
        continue;
      }
      // Spread: fewest pods of the same app first, then fewest pods overall.
      const load = (n: Node, same: boolean) => [...this.pods.values()].filter((x) => x.node === n.name && (!same || x.app === p.app)).length;
      fit.sort((a, b) => load(a, true) - load(b, true) || load(a, false) - load(b, false) || a.name.localeCompare(b.name));
      p.node = fit[0].name;
      p.status = 'ContainerCreating';
      p.startAt = t + 1;
      record(p.events, t, 'Normal', 'Scheduled', 'default-scheduler', `Successfully assigned ${p.ns}/${p.name} to ${p.node}`);
    }
  }

  deletePod(p: Pod) {
    if (p.deleting !== undefined) return;
    p.status = 'Terminating'; p.ready = false;
    // An unscheduled pod has nothing to stop. A scheduled one is removed when its kubelet confirms.
    if (!p.node) { this.pods.delete(`${p.ns}/${p.name}`); return; }
    p.deleting = this.tick + 1;
  }

  /**
   * etcd starts on a data directory: a restored one holds exactly what its
   * snapshot held. This runs once per directory change, never on an API server
   * restart. It used to run inside syncCache at every API server start, which
   * silently deleted every namespace created after the restore the next time
   * the API server restarted, although the restored etcd had committed them.
   */
  private loadDataDir(dir: string) {
    this.etcdLoaded = dir;
    const snap = this.restoredDirs.get(dir);
    if (!snap) return;
    this.droppedByRestore = [...this.namespaces.keys()].filter((n) => !snap.namespaces.includes(n));
    this.namespaces = new Map(snap.nsCreated);
    // An API server running across the swap keeps serving what it had cached.
    if (this.apiservers().length && this.cache) this.cacheStale = true;
  }

  /** Copy what etcd holds into the API server's cache, while both are up, unless the cache went stale under a restore. */
  syncCache() {
    if (this.apiservers().length && this.hasQuorum() && (this.cache === null || !this.cacheStale)) this.cache = { namespaces: [...this.namespaces.keys()] };
  }

  /** Ready as the API's controllers read it: the kubelet's report, unless the node controller has since marked the pod not ready. */
  podReady(p: Pod) { return p.ready && !p.markedNotReady; }

  /**
   * A pod IP from its node's range, allocated once and never shared. kindnet and
   * kube-proxy run on the host network and mirror pods are static, so those show
   * the node's address. It used to be computed from the creation tick, which gave
   * pods that existed at start 10.244.0.-155, and two pods made in one tick the same IP.
   */
  podIP(p: Pod): string {
    const i = this.nodes.findIndex((n) => n.name === p.node);
    if (p.owner.kind === 'Node' || p.app === 'kindnet' || p.app === 'kube-proxy') return `172.18.0.${i + 2}`;
    if (!p.ip) {
      const used = new Set([...this.pods.values()].filter((x) => x.node === p.node && x.ip).map((x) => x.ip));
      let k = this.nextIP.get(p.node!) ?? 2;
      // host-local hands out addresses in order; skip any still held.
      for (let tries = 0; used.has(`10.244.${i}.${k}`) && tries < 253; tries++) k = k >= 254 ? 2 : k + 1;
      p.ip = `10.244.${i}.${k}`;
      this.nextIP.set(p.node!, k >= 254 ? 2 : k + 1);
    }
    return p.ip;
  }

  /** Record any running kubelet newer than the oldest API server. Called after every tick and command. */
  noteSkew() {
    const api = Math.min(...this.nodes.filter((n) => n.controlPlane).map((n) => ver(n.componentVersion).minor));
    for (const n of this.nodes) if (n.kubelet.running && ver(n.kubelet.version).minor > api) this.kubeletAhead.add(n.name);
  }

  /** The snapshot etcd is now serving, if it started on a restored directory. */
  restoredFor(): Snapshot | undefined {
    return this.restoredDirs.get(this.etcdLoaded);
  }

  versions() {
    const cps = this.nodes.filter((n) => n.controlPlane);
    return {
      apiservers: cps.map((n) => n.componentVersion),
      kubelets: this.nodes.map((n) => ({ node: n.name, v: n.kubelet.version })),
      client: this.clientVersion,
    };
  }
}

/** Parse "v1.36.1" into numbers. */
export const ver = (v: string) => { const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v); if (!m) throw new Error(`bad version ${v}`); return { major: +m[1], minor: +m[2], patch: +m[3] }; };

export type SkewCheck = { rule: string; ok: boolean; detail: string };

/**
 * The version-skew policy's rules that the lessons use, as written on
 * https://kubernetes.io/releases/version-skew-policy/ (fetched 2026-11-03).
 * The policy says what is supported; it does not say what a component does
 * when you break it, and neither does this.
 */
export function skew(o: Ops): SkewCheck[] {
  const v = o.versions();
  const minors = v.apiservers.map((x) => ver(x).minor);
  const oldest = Math.min(...minors), newest = Math.max(...minors);
  const checks: SkewCheck[] = [
    { rule: 'kube-apiserver instances within one minor version of each other', ok: newest - oldest <= 1, detail: [...new Set(v.apiservers)].join(', ') },
  ];
  for (const k of v.kubelets) {
    const km = ver(k.v).minor;
    checks.push({ rule: `kubelet on ${k.node}: not newer than kube-apiserver, at most three minors older`, ok: km <= oldest && oldest - km <= 3, detail: k.v });
  }
  const cm = ver(v.client).minor;
  checks.push({ rule: 'kubectl within one minor version of kube-apiserver', ok: Math.abs(cm - newest) <= 1 && Math.abs(cm - oldest) <= 1, detail: v.client });
  return checks;
}
