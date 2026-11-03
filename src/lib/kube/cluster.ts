// A toy cluster whose *failure shapes* are faithful even where its mechanics
// are simplified. Controllers, scheduler and kubelet run as separate passes on
// every tick, the way the real ones run as separate loops, because "nobody
// calls the scheduler, it notices" is the lesson. The failures copy
// TemplateMechanics/tilt labs 09 and 10 on purpose: two crashes that both exit
// 137 for opposite reasons, and a quota refusal that only shows up as an event
// on the ReplicaSet. If the sim said "OOM" for both, the lab would teach the
// wrong reflex. tests/kube.test.ts pins each shape.
//
// Every object lives in a namespace and every map is keyed "namespace/name".
// Keying by bare name once let a Deployment called hello in one namespace
// overwrite a hello in another, which is the exact confusion the namespaces
// lesson is about.
//
// Event wording is copied from a kind v1.36.1 cluster (kubectl 1.37.2),
// 2026-11-03, except where a comment says otherwise. Kubelet events keep the
// container in `field`, because describe prints it as a prefix
// ("spec.containers{app}: Container started") while get events does not.

import { sha1 } from '../git/sha1.ts';
import { IMAGES, type Image } from './images.ts';
import {
  defaultTemplate, effectiveSc, matchesLabels, nodeAffinityOk, psaViolations, tolerates,
  type Ctr, type Level, type Taint, type Template,
} from './spec.ts';

export { defaultTemplate, IMAGES };
export type { Template };

export const SECONDS_PER_TICK = 5;
// The sandbox clock starts here, so CronJob names and creationTimestamps look
// like a cluster's and stay the same on every run.
export const EPOCH_MS = Date.UTC(2026, 10, 3, 6, 0, 0);
// Kubelet resyncs mounted ConfigMaps on its sync period (1 minute by default).
// One update on kind v1.36.1 took about 56 s to appear in the mounted file.
export const VOLUME_SYNC_TICKS = 12;
// terminationGracePeriodSeconds defaults to 30: a container that ignores
// SIGTERM is killed (137) that long after it was asked to stop.
export const GRACE_TICKS = 6;

/** A Deployment condition as the controller stores it. Ticks, not timestamps. */
export type DCond = { type: 'Available' | 'Progressing' | 'ReplicaFailure'; status: 'True' | 'False'; reason: string; message: string; lastUpdate: number; lastTransition: number };
/** What the controller last wrote to .status, kept so the next sync can tell whether anything progressed. */
export type DStatus = { replicas: number; updated: number; ready: number; available: number };
export type Deployment = {
  ns: string; name: string; replicas: number; template: Template; revision: number; history: Template[]; created: number; labels: Record<string, string>;
  progressDeadlineSeconds: number; conditions: DCond[]; status?: DStatus;
};
export type ReplicaSet = { ns: string; name: string; owner: string; hash: string; template: Template; replicas: number; revision: number; backoffUntil: number; failures: number; created: number; failMsg?: string };
export type Termination = { exitCode: number; reason: 'OOMKilled' | 'Error' | 'Completed'; at: number };
export type PodStatus = 'Pending' | 'ContainerCreating' | 'Initializing' | 'Running' | 'CrashLoopBackOff' | 'ErrImagePull' | 'ImagePullBackOff'
  | 'CreateContainerConfigError' | 'Succeeded' | 'Failed' | 'Terminating';
export type CtrState = { name: string; status: 'Waiting' | 'Running' | 'Terminated'; ready: boolean; restarts: number; startedAt?: number; last?: Termination; logs: string[]; previousLogs: string[]; env: Record<string, string> };
export type OwnerKind = 'ReplicaSet' | 'Job' | 'DaemonSet' | null;
export type Pod = {
  ns: string; name: string; uid: string; owner: string; ownerKind: OwnerKind; template: Template; labels: Record<string, string>;
  node?: string; pin?: string; ip?: string; status: PodStatus; ready: boolean;
  restarts: number; created: number; startedAt?: number; nextAction: number; last?: Termination; logs: string[]; previousLogs: string[];
  initDone: number; inits: CtrState[]; sides: CtrState[]; env: Record<string, string>; files: Record<string, string>; volSyncAt: number;
  /** When a finished pod counts as finished: later than now while native sidecars are being stopped. */
  terminalAt?: number;
  mainFinished?: boolean; waitReason?: string; initBackoff?: boolean;
};
export type Node = { name: string; cpu: number; mem: number; labels: Record<string, string>; taints: Taint[]; created: number };
export type NodeSpec = { name: string; cpu: number; mem: number; labels?: Record<string, string>; taints?: Taint[]; controlPlane?: boolean };
export type KEvent = { tick: number; first: number; count: number; type: 'Normal' | 'Warning'; reason: string; object: string; ns: string; message: string; from: string; field?: string };
export type Namespace = { name: string; labels: Record<string, string>; created: number; terminating?: boolean };
export type ConfigMap = { ns: string; name: string; data: Record<string, string>; created: number; labels: Record<string, string> };
export type Secret = { ns: string; name: string; data: Record<string, string>; created: number; type: 'Opaque'; labels: Record<string, string> };
export type Quota = { ns: string; name: string; pods: number; created: number };
export type Job = {
  ns: string; name: string; uid: string; template: Template; completions: number; parallelism: number; backoffLimit: number; suspend: boolean;
  created: number; condition?: 'Complete' | 'Failed'; finishedAt?: number; backoffUntil: number; owner?: string; manual?: boolean; seenByOwner?: boolean; reportedUnexpected?: boolean;
};
export type CronJob = {
  ns: string; name: string; schedule: string; suspend: boolean; concurrencyPolicy: 'Allow' | 'Forbid' | 'Replace'; template: Template; backoffLimit: number;
  created: number; lastSchedule?: number; lastMinute: number; missed: number[]; successfulJobsHistoryLimit: number; failedJobsHistoryLimit: number;
};
export type DaemonSet = { ns: string; name: string; template: Template; created: number; generation: number; labels: Record<string, string> };

export const key = (ns: string, name: string) => `${ns}/${name}`;

// Lab 09's liveness probe: initialDelaySeconds 5, periodSeconds 5,
// failureThreshold 2 - first check at 5 s, second failure at 10 s.
export const LIVENESS = { initialDelaySeconds: 5, periodSeconds: 5, failureThreshold: 2 };
const LIVENESS_KILL = (LIVENESS.initialDelaySeconds + LIVENESS.periodSeconds * (LIVENESS.failureThreshold - 1)) / SECONDS_PER_TICK;
const QUOTA_BACKOFF = [2, 4, 8, 16];
const ALPHABET = 'bcdfghjklmnpqrstvwxz2456789';

export function templateHash(t: Template) {
  // Kubernetes names ReplicaSets by a hash of the pod template, which is why a
  // changed image makes a *new* ReplicaSet instead of editing the old one.
  const s = sha1(new TextEncoder().encode(JSON.stringify(t)));
  return [...s].map((c) => ALPHABET[parseInt(c, 16)]).join('').slice(0, 9);
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function nodeFrom(n: NodeSpec): Node {
  const labels: Record<string, string> = {
    'kubernetes.io/arch': 'amd64', 'kubernetes.io/hostname': n.name, 'kubernetes.io/os': 'linux',
    ...(n.controlPlane ? { 'node-role.kubernetes.io/control-plane': '' } : {}), ...(n.labels ?? {}),
  };
  const taints = n.taints ?? (n.controlPlane ? [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' as const }] : []);
  return { name: n.name, cpu: n.cpu, mem: n.mem, labels, taints, created: 0 };
}

const FROM: Record<string, string> = {
  Scheduled: 'default-scheduler', FailedScheduling: 'default-scheduler', ScalingReplicaSet: 'deployment-controller',
};

export class Cluster {
  tick = 0;
  nodes: Node[];
  namespaces = new Map<string, Namespace>();
  deployments = new Map<string, Deployment>();
  replicasets = new Map<string, ReplicaSet>();
  pods = new Map<string, Pod>();
  configmaps = new Map<string, ConfigMap>();
  secrets = new Map<string, Secret>();
  quotas = new Map<string, Quota>();
  jobs = new Map<string, Job>();
  cronjobs = new Map<string, CronJob>();
  daemonsets = new Map<string, DaemonSet>();
  events: KEvent[] = [];
  /** The kubeconfig context: which namespace kubectl uses when you don't say. */
  context = { name: 'kind-sandbox', namespace: 'default' };
  private seed: number;
  private ipNext = new Map<string, number>();

  constructor(opts: { nodes?: NodeSpec[]; seed?: number } = {}) {
    this.nodes = (opts.nodes ?? [{ name: 'worker-1', cpu: 2000, mem: 4096 }, { name: 'worker-2', cpu: 2000, mem: 4096 }]).map(nodeFrom);
    this.seed = opts.seed ?? 42;
    for (const ns of ['default', 'kube-node-lease', 'kube-public', 'kube-system']) this.addNamespace(ns);
  }

  private rand() {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  suffix(n = 5) {
    let s = '';
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(this.rand() * 27)];
    return s;
  }

  private uids = new WeakMap<object, string>();
  /** A stable uid for any stored object, made the first time someone looks. */
  uidOf(o: object & { uid?: string }) {
    if (o.uid) return o.uid;
    let u = this.uids.get(o);
    if (!u) { u = this.uid(); this.uids.set(o, u); }
    return u;
  }
  private rvClock = 1000;
  private rvSeen = new WeakMap<object, { json: string; rv: number }>();
  /**
   * resourceVersion: one counter for the whole cluster, bumped for an object
   * whenever what is stored for it has changed since it was last read. Derived
   * once from the creation tick, it stayed "1003" through kubectl scale, while
   * the lesson says it changes on every write. Lazy, so two writes between
   * looks show as one step; real numbers are opaque and only ever go up.
   */
  version(o: object) {
    // Logs and the kubelet's own timers are not stored in the API, so they must not count as writes.
    const json = JSON.stringify(o, (k, v) => (k === 'logs' || k === 'previousLogs' || k === 'nextAction' ? undefined : v));
    const seen = this.rvSeen.get(o);
    if (seen && seen.json === json) return seen.rv;
    const rv = ++this.rvClock;
    this.rvSeen.set(o, { json, rv });
    return rv;
  }

  uid() {
    const h = () => Math.floor(this.rand() * 16).toString(16);
    const part = (n: number) => Array.from({ length: n }, h).join('');
    return `${part(8)}-${part(4)}-4${part(3)}-a${part(3)}-${part(12)}`;
  }

  event(type: KEvent['type'], reason: string, object: string, message: string, opts: { ns?: string; from?: string; field?: string } = {}) {
    const ns = opts.ns ?? 'default';
    const from = opts.from ?? FROM[reason] ?? (object.startsWith('pod/') ? 'kubelet' : `${object.split('/')[0]}-controller`);
    // Repeats fold into one event with a count, the way the API server does,
    // so describe can print "(x3 over 17s)".
    const same = this.events.slice(-30).find((e) => e.reason === reason && e.object === object && e.message === message && e.ns === ns && e.field === opts.field);
    if (same) { same.tick = this.tick; same.count++; return; }
    this.events.push({ tick: this.tick, first: this.tick, count: 1, type, reason, object, ns, message, from, field: opts.field });
    if (this.events.length > 400) this.events.shift();
  }

  // ---- namespaces --------------------------------------------------------

  addNamespace(name: string, labels: Record<string, string> = {}) {
    this.namespaces.set(name, { name, created: this.tick, labels: { 'kubernetes.io/metadata.name': name, ...labels } });
    // Every namespace gets this ConfigMap from the root CA publisher; it is
    // why `get cm` in a fresh namespace is not empty.
    this.configmaps.set(key(name, 'kube-root-ca.crt'), { ns: name, name: 'kube-root-ca.crt', data: { 'ca.crt': '-----BEGIN CERTIFICATE-----\n(the cluster CA)\n-----END CERTIFICATE-----' }, created: this.tick, labels: {} });
  }

  namespace(name: string) {
    const n = this.namespaces.get(name);
    if (!n) throw new Error(`Error from server (NotFound): namespaces "${name}" not found`);
    return n;
  }

  /** Writes into a namespace need it to exist and not be on its way out. */
  writable(ns: string, resource: string, name: string) {
    const n = this.namespaces.get(ns);
    if (!n) throw new Error(`Error from server (NotFound): namespaces "${ns}" not found`);
    if (n.terminating) throw new Error(`Error from server (Forbidden): ${resource} "${name}" is forbidden: unable to create new content in namespace ${ns} because it is being terminated`);
  }

  createNamespace(name: string) {
    if (this.namespaces.has(name)) throw new Error(`Error from server (AlreadyExists): namespaces "${name}" already exists`);
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) throw new Error(`The Namespace "${name}" is invalid: metadata.name: Invalid value: "${name}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')`);
    this.addNamespace(name);
  }

  deleteNamespace(name: string) {
    const n = this.namespace(name);
    if (['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(name)) throw new Error(`Error from server (Forbidden): namespaces "${name}" is forbidden: this namespace may not be deleted`);
    n.terminating = true;
    for (const m of [this.deployments, this.replicasets, this.configmaps, this.secrets, this.quotas, this.jobs, this.cronjobs, this.daemonsets] as Map<string, { ns: string }>[]) {
      for (const [k, v] of m) if (v.ns === name) m.delete(k);
    }
    for (const p of this.podsIn(name)) this.deletePod(name, p.name);
  }

  // ---- lookups -----------------------------------------------------------

  podsIn(ns: string | null) { return [...this.pods.values()].filter((p) => ns === null || p.ns === ns); }
  findPod(ns: string, name: string) { return this.pods.get(key(ns, name)); }
  getDeployment(ns: string, name: string) { return this.deployments.get(key(ns, name)); }
  quotaIn(ns: string) { return [...this.quotas.values()].find((q) => q.ns === ns) ?? null; }

  deployment(name: string, ns = 'default') {
    const d = this.deployments.get(key(ns, name));
    if (!d) throw new Error(`Error from server (NotFound): deployments.apps "${name}" not found`);
    return d;
  }

  // ---- API (what kubectl talks to) ---------------------------------------

  createDeployment(name: string, image: string, replicas = 1, ns = 'default', patch: Partial<Template> = {}) {
    this.writable(ns, 'deployments.apps', name);
    if (this.deployments.has(key(ns, name))) throw new Error(`Error from server (AlreadyExists): deployments.apps "${name}" already exists`);
    const template = defaultTemplate(image, { labels: { app: name }, ...patch });
    this.deployments.set(key(ns, name), { ns, name, replicas, template, revision: 0, history: [], created: this.tick, labels: { app: name }, progressDeadlineSeconds: 600, conditions: [] });
  }

  updateTemplate(name: string, change: (t: Template) => void, ns = 'default') {
    const d = this.deployment(name, ns);
    const next = clone(d.template);
    change(next);
    if (JSON.stringify(next) === JSON.stringify(d.template)) return false;
    d.history.push(d.template);
    d.template = next;
    return true;
  }

  deletePod(ns: string, name: string) {
    const p = this.pods.get(key(ns, name));
    if (!p) throw new Error(`Error from server (NotFound): pods "${name}" not found`);
    if (p.status === 'Terminating') return;
    const wasRunning = p.node && (p.status === 'Running' || p.status === 'CrashLoopBackOff');
    p.status = 'Terminating';
    p.ready = false;
    p.nextAction = this.tick + 1;
    if (wasRunning) this.event('Normal', 'Killing', `pod/${name}`, `Stopping container ${p.template.name}`, { ns, field: `spec.containers{${p.template.name}}` });
  }

  deleteDeployment(name: string, ns = 'default') {
    this.deployment(name, ns);
    this.deployments.delete(key(ns, name));
    for (const rs of [...this.replicasets.values()].filter((r) => r.ns === ns && r.owner === name)) {
      this.replicasets.delete(key(ns, rs.name));
      for (const p of this.podsOf(ns, rs.name, 'ReplicaSet')) this.deletePod(ns, p.name);
    }
  }

  deleteJob(ns: string, name: string) {
    if (!this.jobs.delete(key(ns, name))) throw new Error(`Error from server (NotFound): jobs.batch "${name}" not found`);
    for (const p of this.podsOf(ns, name, 'Job')) this.deletePod(ns, p.name);
  }

  podsOf(ns: string, owner: string, kind: OwnerKind = 'ReplicaSet') { return [...this.pods.values()].filter((p) => p.ns === ns && p.owner === owner && p.ownerKind === kind); }
  live(rs: string, ns = 'default') { return this.podsOf(ns, rs).filter((p) => p.status !== 'Terminating'); }

  /** Pods that hold their requests on a node. A finished pod gives its CPU back. */
  holds(p: Pod) { return p.status !== 'Succeeded' && p.status !== 'Failed'; }

  used(node: string) {
    let cpu = 0, mem = 0;
    for (const p of this.pods.values()) if (p.node === node && this.holds(p)) { cpu += p.template.requests.cpu; mem += p.template.requests.mem; }
    return { cpu, mem };
  }

  deploymentStatus(name: string, ns = 'default') {
    const d = this.deployment(name, ns);
    const sets = [...this.replicasets.values()].filter((r) => r.ns === ns && r.owner === name);
    const cur = sets.find((r) => r.hash === templateHash(d.template));
    const pods = sets.flatMap((r) => this.live(r.name, ns));
    const available = pods.filter((p) => p.ready).length;
    // describe's "N unavailable" is the ReplicaSets' *desired* total minus
    // what is available, not the pods that exist (kind v1.36.1: 4 desired,
    // 5 total, 3 available printed "2 unavailable").
    const specTotal = sets.reduce((n, r) => n + r.replicas, 0);
    return {
      desired: d.replicas,
      current: pods.length,
      ready: pods.filter((p) => p.ready).length,
      upToDate: cur ? this.live(cur.name, ns).length : 0,
      available,
      unavailable: Math.max(0, specTotal - available),
      replicaFailure: sets.some((r) => r.failures > 0 && this.live(r.name, ns).length < r.replicas),
    };
  }

  /**
   * maxSurge and maxUnavailable for the default 25%: surge rounds up,
   * unavailable rounds down, and if both come to 0 unavailable becomes 1
   * (ResolveFenceposts in pkg/controller/deployment/util, release-1.36).
   */
  fenceposts(replicas: number) {
    const surge = Math.ceil(replicas * 0.25);
    let unavailable = Math.floor(replicas * 0.25);
    if (surge === 0 && unavailable === 0) unavailable = 1;
    return { surge, unavailable: replicas === 0 ? 0 : Math.min(unavailable, replicas) };
  }

  /** A ReplicaSet's available pods as its status reports them: never more than it is asked to keep. */
  private availableOf(rs: ReplicaSet) { return Math.min(rs.replicas, this.live(rs.name, rs.ns).filter((p) => p.ready).length); }

  jobStatus(j: Job) {
    const pods = this.podsOf(j.ns, j.name, 'Job');
    const done = (p: Pod) => p.terminalAt !== undefined && this.tick >= p.terminalAt;
    const succeeded = pods.filter((p) => p.status === 'Succeeded' && done(p)).length;
    // With restartPolicy OnFailure the pod is restarted in place, and each
    // restart counts against backoffLimit just as a failed pod does.
    const failed = pods.filter((p) => p.status === 'Failed' && done(p)).length + pods.reduce((n, p) => n + (j.template.restartPolicy === 'OnFailure' ? p.restarts : 0), 0);
    const active = pods.filter((p) => p.status !== 'Terminating' && !done(p)).length;
    const ready = pods.filter((p) => p.ready && !done(p)).length;
    return { succeeded, failed, active, ready };
  }

  /** The API server's checks on a new pod: quota, then Pod Security. Returns the refusal, or null. */
  admit(ns: string, podName: string, t: Template): string | null {
    const q = this.quotaIn(ns);
    const inNs = this.podsIn(ns).filter((p) => p.status !== 'Terminating' && this.holds(p)).length;
    if (q && inNs >= q.pods) return `pods "${podName}" is forbidden: exceeded quota: ${q.name}, requested: pods=1, used: pods=${inNs}, limited: pods=${q.pods}`;
    const level = this.psaLevel(ns, 'enforce');
    if (level) {
      const v = psaViolations(t, level);
      if (v.length) return `pods "${podName}" is forbidden: violates PodSecurity "${level}:latest": ${v.map((x) => x.long).join(', ')}`;
    }
    return null;
  }

  psaLevel(ns: string, mode: 'enforce' | 'warn' | 'audit'): Level | null {
    const v = this.namespaces.get(ns)?.labels[`pod-security.kubernetes.io/${mode}`];
    return v === 'privileged' || v === 'baseline' || v === 'restricted' ? v : null;
  }

  newPod(ns: string, name: string, owner: string, ownerKind: OwnerKind, template: Template, labels: Record<string, string>, pin?: string): Pod {
    const p: Pod = {
      ns, name, uid: this.uid(), owner, ownerKind, template, labels, pin, status: 'Pending', ready: false, restarts: 0, created: this.tick, nextAction: this.tick,
      logs: [], previousLogs: [], initDone: 0,
      inits: template.initContainers.map((c) => ({ name: c.name, status: 'Waiting', ready: false, restarts: 0, logs: [], previousLogs: [], env: {} })),
      sides: template.sidecars.map((c) => ({ name: c.name, status: 'Waiting', ready: false, restarts: 0, logs: [], previousLogs: [], env: {} })),
      env: {}, files: {}, volSyncAt: 0,
    };
    this.pods.set(key(ns, name), p);
    return p;
  }

  // ---- the loops ---------------------------------------------------------

  step(n = 1) {
    for (let i = 0; i < n; i++) {
      this.tick++;
      this.namespaceController();
      this.deploymentController();
      this.replicaSetController();
      this.jobController();
      this.cronJobController();
      this.daemonSetController();
      this.taintEviction();
      this.scheduler();
      this.kubelet();
    }
  }

  private namespaceController() {
    for (const n of [...this.namespaces.values()]) {
      if (n.terminating && !this.podsIn(n.name).length) {
        this.namespaces.delete(n.name);
        this.configmaps.delete(key(n.name, 'kube-root-ca.crt'));
        this.events = this.events.filter((e) => e.ns !== n.name);
      }
    }
  }

  /**
   * The rolling update as pkg/controller/deployment/rolling.go (release-1.36)
   * does it, with the default 25% surge and unavailability: scale the new
   * ReplicaSet up while the total stays within replicas + maxSurge, then scale
   * old ones down, first their unavailable pods and then only as far as
   * replicas - maxUnavailable stay available. On kind v1.36.1 a broken image
   * at 4 replicas left old 3 / new 2, and at 10 replicas old 8 / new 5; at 3
   * replicas (surge 1, unavailable 0) no old pod goes until a new one is
   * Ready. That is why a typo in an image tag is a stuck rollout, not an
   * outage. Not modelled: Recreate, proportional scaling of a rollout already
   * in flight, and pruning old ReplicaSets past revisionHistoryLimit.
   */
  private deploymentController() {
    for (const d of this.deployments.values()) {
      const hash = templateHash(d.template);
      const name = `${d.name}-${hash}`;
      const sets = () => [...this.replicasets.values()].filter((r) => r.ns === d.ns && r.owner === d.name);
      const spec = () => sets().reduce((n, r) => n + r.replicas, 0);
      const scale = (rs: ReplicaSet, to: number) => {
        if (to === rs.replicas) return false;
        this.event('Normal', 'ScalingReplicaSet', `deployment/${d.name}`, `Scaled ${to > rs.replicas ? 'up' : 'down'} replica set ${rs.name} from ${rs.replicas} to ${to}`, { ns: d.ns });
        rs.replicas = to;
        return true;
      };
      const { surge, unavailable } = this.fenceposts(d.replicas);
      const minAvailable = d.replicas - unavailable;
      let cur = this.replicasets.get(key(d.ns, name));
      if (!cur) {
        d.revision++;
        cur = { ns: d.ns, name, owner: d.name, hash, template: d.template, replicas: 0, revision: d.revision, backoffUntil: 0, failures: 0, created: this.tick };
        this.replicasets.set(key(d.ns, name), cur);
        this.setCond(d, { type: 'Progressing', status: 'True', reason: 'NewReplicaSetCreated', message: `Created new replica set "${name}"` });
      } else if (cur.revision < d.revision) {
        // rollout undo back to an old template reuses its ReplicaSet and gives it the next revision.
        cur.revision = ++d.revision;
      }
      const olds = () => sets().filter((r) => r !== cur && r.replicas > 0).sort((a, b) => a.created - b.created);
      const scaleUp = () => {
        if (cur.replicas > d.replicas) return scale(cur, d.replicas);
        if (!olds().length) return scale(cur, d.replicas);
        const room = d.replicas + surge - spec();
        return room > 0 && scale(cur, cur.replicas + Math.min(room, d.replicas - cur.replicas));
      };
      const scaleDown = () => {
        if (!olds().length) return false;
        const maxScaledDown = spec() - minAvailable - (cur.replicas - this.availableOf(cur));
        if (maxScaledDown <= 0) return false;
        let done = 0, changed = false;
        for (const r of olds()) {
          if (done >= maxScaledDown) break;
          const bad = r.replicas - this.availableOf(r);
          if (bad <= 0) continue;
          const n = Math.min(maxScaledDown - done, bad);
          changed = scale(r, r.replicas - n) || changed;
          done += n;
        }
        let left = sets().reduce((n, r) => n + this.availableOf(r), 0) - minAvailable;
        for (const r of olds()) {
          if (left <= 0) break;
          const n = Math.min(r.replicas, left);
          changed = scale(r, r.replicas - n) || changed;
          left -= n;
        }
        return changed;
      };
      // The real controller re-syncs as soon as a ReplicaSet changes, so the
      // first steps of a rollout land within a second; a few passes per tick
      // stand in for that.
      for (let pass = 0; pass < 4; pass++) if (!scaleUp() && !scaleDown()) break;
      this.syncRolloutStatus(d, cur, minAvailable);
    }
  }

  /** The SetDeploymentCondition rule: same status and reason changes nothing; otherwise the condition moves to the end. */
  private setCond(d: Deployment, c: Omit<DCond, 'lastUpdate' | 'lastTransition'>) {
    const was = d.conditions.find((x) => x.type === c.type);
    if (was && was.status === c.status && was.reason === c.reason) return;
    const lastTransition = was && was.status === c.status ? was.lastTransition : this.tick;
    d.conditions = [...d.conditions.filter((x) => x.type !== c.type), { ...c, lastUpdate: this.tick, lastTransition }];
  }

  /** Available, Progressing and ReplicaFailure, in the order and with the wording of release-1.36's progress.go and sync.go. */
  private syncRolloutStatus(d: Deployment, cur: ReplicaSet, minAvailable: number) {
    const st = this.deploymentStatus(d.name, d.ns);
    const now: DStatus = { replicas: st.current, updated: st.upToDate, ready: st.ready, available: st.available };
    const before = d.status ?? { replicas: 0, updated: 0, ready: 0, available: 0 };
    this.setCond(d, st.available >= minAvailable
      ? { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable', message: 'Deployment has minimum availability.' }
      : { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable', message: 'Deployment does not have minimum availability.' });
    const pc = d.conditions.find((x) => x.type === 'Progressing');
    const alreadyComplete = now.replicas === now.updated && pc?.reason === 'NewReplicaSetAvailable';
    if (!alreadyComplete) {
      const complete = now.updated === d.replicas && now.replicas === d.replicas && now.available === d.replicas;
      const progressed = now.updated > before.updated || now.replicas - now.updated < before.replicas - before.updated || now.ready > before.ready || now.available > before.available;
      if (complete) this.setCond(d, { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable', message: `ReplicaSet "${cur.name}" has successfully progressed.` });
      else if (progressed) {
        // Progress refreshes lastUpdateTime even with the same reason: that is
        // the clock progressDeadlineSeconds is measured from.
        const keep = pc?.status === 'True' ? pc.lastTransition : this.tick;
        d.conditions = [...d.conditions.filter((x) => x.type !== 'Progressing'), { type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated', message: `ReplicaSet "${cur.name}" is progressing.`, lastUpdate: this.tick, lastTransition: keep }];
      } else if (pc && (pc.reason === 'ProgressDeadlineExceeded' || (this.tick - pc.lastUpdate) * SECONDS_PER_TICK > d.progressDeadlineSeconds)) {
        this.setCond(d, { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: `ReplicaSet "${cur.name}" has timed out progressing.` });
      }
    }
    const failing = [...this.replicasets.values()].find((r) => r.ns === d.ns && r.owner === d.name && r.failures > 0 && this.live(r.name, r.ns).length < r.replicas);
    if (failing) this.setCond(d, { type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: failing.failMsg ?? '' });
    else d.conditions = d.conditions.filter((x) => x.type !== 'ReplicaFailure');
    d.status = now;
  }

  private replicaSetController() {
    for (const rs of this.replicasets.values()) {
      const live = this.live(rs.name, rs.ns);
      if (live.length > rs.replicas) {
        const victims = live.sort((a, b) => Number(a.ready) - Number(b.ready) || b.created - a.created).slice(0, live.length - rs.replicas);
        for (const v of victims) this.deletePod(rs.ns, v.name);
        continue;
      }
      if (live.length === rs.replicas || this.tick < rs.backoffUntil) continue;
      for (let i = live.length; i < rs.replicas; i++) {
        const name = `${rs.name}-${this.suffix()}`;
        const refused = this.admit(rs.ns, name, rs.template);
        if (refused) {
          this.event('Warning', 'FailedCreate', `replicaset/${rs.name}`, `Error creating: ${refused}`, { ns: rs.ns });
          rs.failMsg = refused;
          // The ReplicaSet backs off after repeated refusals, so a fixed quota
          // is not obeyed instantly - lab 10 measured minutes. Kept short here.
          rs.backoffUntil = this.tick + QUOTA_BACKOFF[Math.min(rs.failures, QUOTA_BACKOFF.length - 1)];
          rs.failures++;
          break;
        }
        this.newPod(rs.ns, name, rs.name, 'ReplicaSet', rs.template, { ...rs.template.labels, 'pod-template-hash': rs.hash });
        this.event('Normal', 'SuccessfulCreate', `replicaset/${rs.name}`, `Created pod: ${name}`, { ns: rs.ns });
      }
      if (this.live(rs.name, rs.ns).length === rs.replicas) rs.failures = 0;
    }
  }

  private jobController() {
    for (const j of this.jobs.values()) {
      if (j.condition || j.suspend) continue;
      const s = this.jobStatus(j);
      if (s.succeeded >= j.completions) {
        j.condition = 'Complete';
        j.finishedAt = this.tick;
        this.event('Normal', 'Completed', `job/${j.name}`, 'Job completed', { ns: j.ns });
        continue;
      }
      if (s.failed > j.backoffLimit) {
        j.condition = 'Failed';
        j.finishedAt = this.tick;
        for (const p of this.podsOf(j.ns, j.name, 'Job').filter((x) => x.status !== 'Terminating' && x.terminalAt === undefined)) {
          this.event('Normal', 'SuccessfulDelete', `job/${j.name}`, `Deleted pod: ${p.name}`, { ns: j.ns });
          this.deletePod(j.ns, p.name);
        }
        this.event('Warning', 'BackoffLimitExceeded', `job/${j.name}`, 'Job has reached the specified backoff limit', { ns: j.ns });
        continue;
      }
      // A failed pod makes the next one wait: 10 s, 20 s, 40 s... (measured on
      // kind: pods at 0, 11, 32 and 73 s). Worked out before creating, or the
      // replacement would start in the same tick the failure was seen.
      const newest = Math.max(-1, ...this.podsOf(j.ns, j.name, 'Job').filter((p) => p.status === 'Failed').map((p) => p.terminalAt ?? -1));
      if (s.failed > 0 && newest >= 0) j.backoffUntil = Math.max(j.backoffUntil, newest + 2 * 2 ** Math.min(s.failed - 1, 5));
      const want = Math.min(j.parallelism, j.completions - s.succeeded) - s.active;
      if (want <= 0 || this.tick < j.backoffUntil) continue;
      for (let i = 0; i < want; i++) {
        const name = `${j.name}-${this.suffix()}`;
        const refused = this.admit(j.ns, name, j.template);
        if (refused) {
          this.event('Warning', 'FailedCreate', `job/${j.name}`, `Error creating: ${refused}`, { ns: j.ns });
          j.backoffUntil = this.tick + 4;
          break;
        }
        const labels = { 'batch.kubernetes.io/controller-uid': j.uid, 'batch.kubernetes.io/job-name': j.name, 'controller-uid': j.uid, 'job-name': j.name, ...j.template.labels };
        this.newPod(j.ns, name, j.name, 'Job', j.template, labels);
        this.event('Normal', 'SuccessfulCreate', `job/${j.name}`, `Created pod: ${name}`, { ns: j.ns });
      }
    }
  }

  createJob(ns: string, name: string, template: Template, opts: { backoffLimit?: number; completions?: number; parallelism?: number; owner?: string; manual?: boolean } = {}) {
    this.writable(ns, 'jobs.batch', name);
    if (this.jobs.has(key(ns, name))) throw new Error(`Error from server (AlreadyExists): jobs.batch "${name}" already exists`);
    const j: Job = {
      ns, name, uid: this.uid(), template, completions: opts.completions ?? 1, parallelism: opts.parallelism ?? 1, backoffLimit: opts.backoffLimit ?? 6,
      suspend: false, created: this.tick, backoffUntil: 0, owner: opts.owner, manual: opts.manual,
    };
    this.jobs.set(key(ns, name), j);
    return j;
  }

  minuteAt(tick: number) { return Math.floor((EPOCH_MS + tick * SECONDS_PER_TICK * 1000) / 60000); }

  private cronJobController() {
    const now = this.minuteAt(this.tick);
    for (const cj of this.cronjobs.values()) {
      const owned = [...this.jobs.values()].filter((j) => j.ns === cj.ns && j.owner === cj.name);
      for (const j of owned) {
        if (j.condition && !j.seenByOwner && !j.manual) {
          j.seenByOwner = true;
          this.event('Normal', 'SawCompletedJob', `cronjob/${cj.name}`, `Saw completed job: ${j.name}, condition: ${j.condition}`, { ns: cj.ns });
        }
      }
      // A job made by hand with --from=cronjob/x points at the CronJob, which
      // complains that it never made it. Harmless, and real. The controller
      // only complains about unfinished Jobs, once per sync: on kind v1.36.1
      // a quick manual Job got the warning once. Firing it every other tick
      // once ran the count to x20 for a Job long since complete.
      for (const j of this.jobs.values()) {
        if (j.ns === cj.ns && j.manual && j.owner === cj.name && !j.condition && !j.reportedUnexpected) {
          j.reportedUnexpected = true;
          this.event('Warning', 'UnexpectedJob', `cronjob/${cj.name}`, `Saw a job that the controller did not create or forgot: ${j.name}`, { ns: cj.ns });
        }
      }
      this.trimHistory(cj, owned);
      for (let m = cj.lastMinute + 1; m <= now; m++) if (cronMatches(cj.schedule, m)) this.fire(cj, m);
      cj.lastMinute = Math.max(cj.lastMinute, now);
    }
  }

  fire(cj: CronJob, minute: number) {
    if (cj.suspend) { cj.missed = [...cj.missed.slice(-99), minute]; return; }
    const active = [...this.jobs.values()].filter((j) => j.ns === cj.ns && j.owner === cj.name && !j.manual && !j.condition);
    if (active.length && cj.concurrencyPolicy === 'Forbid') {
      this.event('Normal', 'JobAlreadyActive', `cronjob/${cj.name}`, 'Not starting job because prior execution is running and concurrency policy is Forbid', { ns: cj.ns });
      return;
    }
    if (active.length && cj.concurrencyPolicy === 'Replace') {
      for (const j of active) { this.deleteJob(cj.ns, j.name); this.event('Normal', 'SuccessfulDelete', `cronjob/${cj.name}`, `Deleted job ${j.name}`, { ns: cj.ns }); }
    }
    const name = `${cj.name}-${minute}`;
    if (this.jobs.has(key(cj.ns, name))) return;
    this.createJob(cj.ns, name, clone(cj.template), { backoffLimit: cj.backoffLimit, owner: cj.name });
    cj.lastSchedule = this.tick;
    this.event('Normal', 'SuccessfulCreate', `cronjob/${cj.name}`, `Created job ${name}`, { ns: cj.ns });
  }

  private trimHistory(cj: CronJob, owned: Job[]) {
    const auto = owned.filter((j) => !j.manual);
    for (const [cond, limit] of [['Complete', cj.successfulJobsHistoryLimit], ['Failed', cj.failedJobsHistoryLimit]] as const) {
      const done = auto.filter((j) => j.condition === cond).sort((a, b) => a.created - b.created);
      for (const j of done.slice(0, Math.max(0, done.length - limit))) {
        this.deleteJob(cj.ns, j.name);
        this.event('Normal', 'SuccessfulDelete', `cronjob/${cj.name}`, `Deleted job ${j.name}`, { ns: cj.ns });
      }
    }
  }

  /** Where a DaemonSet wants a pod: no untolerated NoSchedule or NoExecute taint, and its selector matches. */
  dsWants(ds: DaemonSet, n: Node) {
    const hard = n.taints.filter((t) => t.effect !== 'PreferNoSchedule' && !tolerates(ds.template.tolerations, t));
    const fits = nodeAffinityOk(ds.template, n.labels);
    // A NoSchedule taint added after the pod started only stops new pods: the
    // running one stays, and DESIRED still counts it (seen on kind v1.36.1).
    return { shouldRun: fits && !hard.length, keep: fits && !hard.some((t) => t.effect === 'NoExecute') };
  }

  private daemonSetController() {
    for (const ds of this.daemonsets.values()) {
      const hash = templateHash(ds.template).slice(0, 8);
      const pods = this.podsOf(ds.ns, ds.name, 'DaemonSet').filter((p) => p.status !== 'Terminating');
      for (const n of this.nodes) {
        const mine = pods.filter((p) => p.pin === n.name);
        const want = this.dsWants(ds, n);
        if (!mine.length && want.shouldRun) {
          const name = `${ds.name}-${this.suffix()}`;
          const refused = this.admit(ds.ns, name, ds.template);
          if (refused) { this.event('Warning', 'FailedCreate', `daemonset/${ds.name}`, `Error creating: ${refused}`, { ns: ds.ns }); continue; }
          this.newPod(ds.ns, name, ds.name, 'DaemonSet', ds.template, { ...ds.template.labels, 'controller-revision-hash': hash, 'pod-template-generation': String(ds.generation) }, n.name);
          this.event('Normal', 'SuccessfulCreate', `daemonset/${ds.name}`, `Created pod: ${name}`, { ns: ds.ns });
        }
        if (mine.length && !want.keep) {
          for (const p of mine) { this.deletePod(ds.ns, p.name); this.event('Normal', 'SuccessfulDelete', `daemonset/${ds.name}`, `Deleted pod: ${p.name}`, { ns: ds.ns }); }
        }
      }
      // RollingUpdate with maxUnavailable 1: replace one stale pod at a time,
      // and only while every other pod is Ready.
      const stale = pods.filter((p) => p.labels['controller-revision-hash'] !== hash);
      if (stale.length && pods.every((p) => p.ready || stale.includes(p)) && !this.podsOf(ds.ns, ds.name, 'DaemonSet').some((p) => p.status === 'Terminating')) {
        const v = stale[0];
        this.deletePod(ds.ns, v.name);
        this.event('Normal', 'SuccessfulDelete', `daemonset/${ds.name}`, `Deleted pod: ${v.name}`, { ns: ds.ns });
      }
    }
  }

  dsStatus(ds: DaemonSet) {
    const hash = templateHash(ds.template).slice(0, 8);
    const pods = this.podsOf(ds.ns, ds.name, 'DaemonSet').filter((p) => p.status !== 'Terminating');
    const desired = this.nodes.filter((n) => { const w = this.dsWants(ds, n); return w.shouldRun || (w.keep && pods.some((p) => p.pin === n.name)); }).length;
    const current = new Set(pods.map((p) => p.pin)).size;
    return { desired, current, ready: pods.filter((p) => p.ready).length, upToDate: pods.filter((p) => p.labels['controller-revision-hash'] === hash).length, available: pods.filter((p) => p.ready).length };
  }

  /** NoExecute evicts what is already running, unless the pod tolerates it. */
  private taintEviction() {
    for (const p of this.pods.values()) {
      if (!p.node || p.status === 'Terminating') continue;
      const n = this.nodes.find((x) => x.name === p.node);
      if (n?.taints.some((t) => t.effect === 'NoExecute' && !tolerates(p.template.tolerations, t))) this.deletePod(p.ns, p.name);
    }
  }

  // ---- the scheduler -----------------------------------------------------

  private scheduler() {
    for (const p of this.pods.values()) {
      if (p.node || p.status === 'Terminating') continue;
      const verdicts = this.nodes.map((n) => ({ n, why: this.filter(p, n) }));
      const fits = verdicts.filter((v) => !v.why.length).map((v) => v.n);
      if (!fits.length) {
        this.event('Warning', 'FailedScheduling', `pod/${p.name}`, this.fitError(verdicts.map((v) => v.why)), { ns: p.ns });
        continue;
      }
      const best = fits.map((n) => ({ n, s: this.score(p, n) })).sort((a, b) => a.s - b.s)[0].n;
      p.node = best.name;
      p.ip = this.nextIp(best.name);
      p.status = 'ContainerCreating';
      p.nextAction = this.tick + 1;
      this.event('Normal', 'Scheduled', `pod/${p.name}`, `Successfully assigned ${p.ns}/${p.name} to ${best.name}`, { ns: p.ns });
    }
  }

  private nextIp(node: string) {
    const i = this.nodes.findIndex((n) => n.name === node) + 1;
    const n = (this.ipNext.get(node) ?? 2) + 1;
    this.ipNext.set(node, n);
    return `10.244.${i}.${n}`;
  }

  /** Why one node cannot take this pod, in the order the real filter plugins run. Empty means it fits. */
  filter(p: Pod, n: Node): { reason: string; hopeless: boolean }[] {
    const t = p.template;
    if (p.pin && p.pin !== n.name) return [{ reason: "node(s) didn't match Pod's node affinity/selector", hopeless: true }];
    if (n.taints.some((x) => x.effect !== 'PreferNoSchedule' && !tolerates(t.tolerations, x))) return [{ reason: 'node(s) had untolerated taint(s)', hopeless: true }];
    if (!nodeAffinityOk(t, n.labels)) return [{ reason: "node(s) didn't match Pod's node affinity/selector", hopeless: true }];
    const u = this.used(n.name);
    const res: { reason: string; hopeless: boolean }[] = [];
    if (u.cpu + t.requests.cpu > n.cpu) res.push({ reason: 'Insufficient cpu', hopeless: false });
    if (u.mem + t.requests.mem > n.mem) res.push({ reason: 'Insufficient memory', hopeless: false });
    if (res.length) return res;
    for (const s of t.spread.filter((x) => x.whenUnsatisfiable === 'DoNotSchedule')) {
      if (!(s.topologyKey in n.labels)) return [{ reason: "node(s) didn't match pod topology spread constraints (missing required label)", hopeless: true }];
      const counts = this.domainCounts(p, s.topologyKey, s.matchLabels);
      const min = Math.min(...counts.values());
      if ((counts.get(n.labels[s.topologyKey]) ?? 0) + 1 - min > s.maxSkew) return [{ reason: "node(s) didn't match pod topology spread constraints", hopeless: false }];
    }
    for (const a of t.affinity.antiRequired) {
      const here = n.labels[a.topologyKey];
      if (here === undefined) continue;
      const clash = this.podsIn(p.ns).some((o) => o !== p && o.node && o.status !== 'Terminating' && this.holds(o) && matchesLabels(o.labels, a.matchLabels)
        && this.nodes.find((x) => x.name === o.node)?.labels[a.topologyKey] === here);
      if (clash) return [{ reason: "node(s) didn't match pod anti-affinity rules", hopeless: false }];
    }
    // Required anti-affinity is symmetric: a pod already running can keep
    // newcomers it selects off its domain, even if they say nothing. This is
    // checked after the pod's own rules, which is why the two messages differ.
    for (const o of this.podsIn(p.ns)) {
      if (o === p || !o.node || o.status === 'Terminating' || !this.holds(o)) continue;
      const on = this.nodes.find((x) => x.name === o.node);
      for (const a of o.template.affinity.antiRequired) {
        if (matchesLabels(p.labels, a.matchLabels) && on?.labels[a.topologyKey] !== undefined && on.labels[a.topologyKey] === n.labels[a.topologyKey]) {
          return [{ reason: "node(s) didn't satisfy existing pods anti-affinity rules", hopeless: false }];
        }
      }
    }
    return [];
  }

  /** Pods matching a selector per topology domain. Taints do not remove a domain (nodeTaintsPolicy defaults to Ignore). */
  domainCounts(p: Pod, topologyKey: string, sel: Record<string, string>) {
    const counts = new Map<string, number>();
    for (const n of this.nodes) {
      if (!(topologyKey in n.labels) || !nodeAffinityOk(p.template, n.labels)) continue;
      const d = n.labels[topologyKey];
      counts.set(d, counts.get(d) ?? 0);
    }
    for (const o of this.podsIn(p.ns)) {
      if (o === p || !o.node || o.status === 'Terminating' || !this.holds(o) || !matchesLabels(o.labels, sel)) continue;
      const d = this.nodes.find((x) => x.name === o.node)?.labels[topologyKey];
      if (d !== undefined && counts.has(d)) counts.set(d, counts.get(d)! + 1);
    }
    return counts;
  }

  /**
   * The FailedScheduling message as a v1.36 scheduler writes it: a count per
   * reason, sorted as text, then the preemption verdict per node. A node that
   * fails on a taint or a selector can never be helped by evicting pods.
   */
  fitError(whys: { reason: string; hopeless: boolean }[][]) {
    const total = this.nodes.length;
    const counts = new Map<string, number>();
    for (const w of whys) for (const r of w) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
    const reasons = [...counts].map(([r, c]) => `${c} ${r}`).sort();
    const hopeless = whys.filter((w) => w.some((r) => r.hopeless)).length;
    const pre = [hopeless && `${hopeless} Preemption is not helpful for scheduling`, total - hopeless && `${total - hopeless} No preemption victims found for incoming pod`].filter(Boolean) as string[];
    return `0/${total} nodes are available: ${reasons.join(', ')}. no new claims to deallocate, preemption: 0/${total} nodes are available: ${pre.sort().join(', ')}.`;
  }

  /** Lower is better: least-requested CPU, then soft spreading and preferred anti-affinity. */
  private score(p: Pod, n: Node) {
    let s = this.used(n.name).cpu / n.cpu;
    for (const a of p.template.affinity.antiPreferred) {
      const here = n.labels[a.term.topologyKey];
      const same = this.podsIn(p.ns).filter((o) => o !== p && o.node && this.holds(o) && o.status !== 'Terminating' && matchesLabels(o.labels, a.term.matchLabels)
        && this.nodes.find((x) => x.name === o.node)?.labels[a.term.topologyKey] === here).length;
      s += same * a.weight;
    }
    for (const sp of p.template.spread.filter((x) => x.whenUnsatisfiable === 'ScheduleAnyway')) {
      s += (this.domainCounts(p, sp.topologyKey, sp.matchLabels).get(n.labels[sp.topologyKey]) ?? 0) * 10;
    }
    return s;
  }

  // ---- the kubelet -------------------------------------------------------

  private kevent(p: Pod, type: KEvent['type'], reason: string, message: string, ctr: string, init = false) {
    this.event(type, reason, `pod/${p.name}`, message, { ns: p.ns, field: `spec.${init ? 'initContainers' : 'containers'}{${ctr}}` });
  }

  private kubelet() {
    for (const p of [...this.pods.values()]) {
      this.stopSidecars(p);
      if (p.node && p.volSyncAt && this.tick >= p.volSyncAt && p.status !== 'Terminating') { this.syncFiles(p, false); p.volSyncAt = this.tick + VOLUME_SYNC_TICKS; }
      if (this.tick < p.nextAction) { this.tickExtras(p); continue; }
      const img = IMAGES[p.template.image];
      switch (p.status) {
        case 'Terminating':
          this.pods.delete(key(p.ns, p.name));
          break;
        case 'ContainerCreating':
        case 'ErrImagePull':
        case 'ImagePullBackOff':
        case 'CreateContainerConfigError':
          if (!this.mountVolumes(p)) break;
          if (p.initDone < p.template.initContainers.length) { this.runInit(p); break; }
          this.startMain(p);
          break;
        case 'Initializing':
          this.runInit(p);
          break;
        case 'CrashLoopBackOff':
          this.startMain(p);
          break;
        case 'Running':
          if (!p.mainFinished) this.runContainer(p, img);
          break;
      }
      this.tickExtras(p);
    }
  }

  /** Pull an image, or say why not. The wording is the containerd/kubelet text from a real bad tag. */
  private pull(p: Pod, image: string, ctr: string, init: boolean, retry: boolean) {
    if (IMAGES[image]) return true;
    const ref = `docker.io/${image}`;
    if (retry) {
      this.kevent(p, 'Normal', 'BackOff', `Back-off pulling image "${image}"`, ctr, init);
      this.kevent(p, 'Warning', 'Failed', 'Error: ImagePullBackOff', ctr, init);
      p.status = 'ImagePullBackOff';
    } else {
      this.kevent(p, 'Normal', 'Pulling', `Pulling image "${image}"`, ctr, init);
      this.kevent(p, 'Warning', 'Failed', `Failed to pull image "${image}": rpc error: code = NotFound desc = failed to pull and unpack image "${ref}": failed to resolve reference "${ref}": ${ref}: not found`, ctr, init);
      this.kevent(p, 'Warning', 'Failed', 'Error: ErrImagePull', ctr, init);
      p.status = 'ErrImagePull';
    }
    p.nextAction = this.tick + (retry ? 4 : 1);
    return false;
  }

  private mountVolumes(p: Pod) {
    for (const v of p.template.volumes) {
      const kind = v.configMap ? 'configmap' : v.secret ? 'secret' : null;
      if (!kind) continue;
      const src = v.configMap ? this.configmaps.get(key(p.ns, v.configMap)) : this.secrets.get(key(p.ns, v.secret!));
      if (!src) {
        this.event('Warning', 'FailedMount', `pod/${p.name}`, `MountVolume.SetUp failed for volume "${v.name}" : ${kind} "${v.configMap ?? v.secret}" not found`, { ns: p.ns });
        p.status = 'ContainerCreating';
        p.nextAction = this.tick + 2;
        return false;
      }
    }
    if (!p.volSyncAt) { this.syncFiles(p, true); p.volSyncAt = this.tick + VOLUME_SYNC_TICKS; }
    return true;
  }

  /**
   * Copy ConfigMap and Secret contents into the pod's mounted files. A subPath
   * mount is a bind mount of the file as it was when the container started,
   * so it is filled once here and never again: the docs say such a mount
   * "will not receive ConfigMap updates", and kind agreed.
   */
  private syncFiles(p: Pod, first: boolean) {
    const ctrs: { mounts: Ctr['mounts'] }[] = [p.template, ...p.template.initContainers, ...p.template.sidecars];
    for (const c of ctrs) for (const m of c.mounts) {
      const v = p.template.volumes.find((x) => x.name === m.name);
      if (!v) continue;
      if (v.emptyDir) { if (first) p.files[`${m.mountPath}/`] = ''; continue; }
      const src = v.configMap ? this.configmaps.get(key(p.ns, v.configMap)) : v.secret ? this.secrets.get(key(p.ns, v.secret)) : undefined;
      if (!src) continue;
      if (m.subPath) { if (first && m.subPath in src.data) p.files[m.mountPath] = src.data[m.subPath]; continue; }
      for (const f of Object.keys(p.files)) if (f.startsWith(m.mountPath + '/')) delete p.files[f];
      for (const [k, val] of Object.entries(src.data)) p.files[`${m.mountPath}/${k}`] = val;
    }
  }

  /** Env as the container sees it, resolved once when it starts. Returns the kubelet's error if a reference is missing. */
  resolveEnv(ns: string, c: { env: Record<string, string>; envRefs: Ctr['envRefs']; envFrom: Ctr['envFrom'] }): { env: Record<string, string> } | { error: string } {
    const env: Record<string, string> = {};
    const get = (kind: 'configMap' | 'secret', name: string) => kind === 'configMap' ? this.configmaps.get(key(ns, name)) : this.secrets.get(key(ns, name));
    for (const src of c.envFrom) {
      const o = get(src.kind, src.name);
      if (!o) return { error: `Error: ${src.kind === 'configMap' ? 'configmap' : 'secret'} "${src.name}" not found` };
      Object.assign(env, o.data);
    }
    for (const r of c.envRefs) {
      const o = get(r.kind, r.ref);
      if (!o) return { error: `Error: ${r.kind === 'configMap' ? 'configmap' : 'secret'} "${r.ref}" not found` };
      if (!(r.key in o.data)) return { error: `Error: couldn't find key ${r.key} in ${r.kind === 'configMap' ? 'ConfigMap' : 'Secret'} ${ns}/${r.ref}` };
      env[r.name] = o.data[r.key];
    }
    return { env: { ...env, ...c.env } };
  }

  /** The kubelet's runAsNonRoot check, made against the user the image declares. */
  private nonRootError(p: Pod, sc: ReturnType<typeof effectiveSc>, image: string, ctr: string) {
    if (!sc.runAsNonRoot) return null;
    const who = `(pod: "${p.name}_${p.ns}(${p.uid})", container: ${ctr})`;
    if (sc.runAsUser === 0) return `Error: container's runAsUser breaks non-root policy ${who}`;
    if (sc.runAsUser === undefined && (IMAGES[image]?.user ?? 0) === 0) return `Error: container has runAsNonRoot and image will run as root ${who}`;
    return null;
  }

  private runInit(p: Pod): void {
    const idx = p.initDone;
    const spec = p.template.initContainers[idx];
    const st = p.inits[idx];
    if (!spec) { p.status = 'ContainerCreating'; p.nextAction = this.tick + 1; return; }
    const img = IMAGES[spec.image];
    if (st.status === 'Waiting') {
      if (!this.pull(p, spec.image, spec.name, true, p.status === 'ErrImagePull' || p.status === 'ImagePullBackOff')) return;
      const env = this.resolveEnv(p.ns, spec);
      const nonRoot = this.nonRootError(p, effectiveSc(p.template, spec.sc), spec.image, spec.name);
      const err = 'error' in env ? env.error : nonRoot;
      if (err) {
        this.kevent(p, 'Warning', 'Failed', err, spec.name, true);
        p.status = 'CreateContainerConfigError';
        p.waitReason = 'CreateContainerConfigError';
        p.nextAction = this.tick + 2;
        return;
      }
      st.env = (env as { env: Record<string, string> }).env;
      this.kevent(p, 'Normal', 'Pulled', `Container image "${spec.image}" already present on machine and can be accessed by the pod`, spec.name, true);
      this.kevent(p, 'Normal', 'Created', 'Container created', spec.name, true);
      this.kevent(p, 'Normal', 'Started', 'Container started', spec.name, true);
      st.previousLogs = st.restarts ? st.logs : [];
      st.logs = [];
      st.status = 'Running';
      st.startedAt = this.tick;
      p.status = 'Initializing';
      p.initBackoff = false;
      p.nextAction = this.tick + 1;
      // A native sidecar (an init container with restartPolicy: Always) does
      // not block the next one: it starts, and the sequence moves on at once.
      // Waiting a tick here once printed Init:1/1 and then PodInitializing,
      // which kubectl never shows for a started sidecar: on kind v1.36.1 the
      // pod went from 0/2 Init:0/1 straight to 2/2 Running.
      if (spec.restartPolicy === 'Always') {
        st.ready = true; st.logs.push(...img.log.slice(0, 1)); p.initDone++;
        if (p.initDone < p.template.initContainers.length) return this.runInit(p);
        return this.startMain(p);
      }
      return;
    }
    const age = this.tick - (st.startedAt ?? this.tick);
    p.nextAction = this.tick + 1;
    if (img.behaviour === 'wait-for-db') {
      const db = this.podsIn(p.ns).some((o) => o.labels.app === 'db' && o.ready);
      if (db) { st.logs.push('db is up'); return this.finishInit(p, 0); }
      if (age % 2 === 1) st.logs.push('waiting for db');
      return;
    }
    if (img.behaviour === 'batch') {
      if (age === 1) st.logs.push(img.log[0]);
      if (img.needsEnv && !st.env[img.needsEnv]) { st.logs.push(`error: ${img.needsEnv} is not set - refusing to start without a database`); return this.finishInit(p, 1); }
      if (age >= (img.runTicks ?? 1)) { st.logs.push(...img.log.slice(1)); return this.finishInit(p, img.exitCode ?? 0); }
      return;
    }
    // Any other image never exits, so as a plain init container it blocks the pod for ever.
    if (age === 1) st.logs.push(...img.log.slice(0, 1));
  }

  private finishInit(p: Pod, code: number) {
    const idx = p.initDone;
    const spec = p.template.initContainers[idx];
    const st = p.inits[idx];
    st.status = 'Terminated';
    st.last = { exitCode: code, reason: code ? 'Error' : 'Completed', at: this.tick };
    if (code === 0) {
      p.initDone++;
      p.status = p.initDone < p.template.initContainers.length ? 'Initializing' : 'ContainerCreating';
      p.nextAction = this.tick + 1;
      return;
    }
    if (p.template.restartPolicy === 'Never') {
      p.status = 'Failed';
      p.terminalAt = this.tick;
      return;
    }
    st.restarts++;
    st.status = 'Waiting';
    p.initBackoff = true;
    const delay = Math.min(60, 2 * 2 ** Math.min(st.restarts - 1, 5));
    p.nextAction = this.tick + delay;
    this.kevent(p, 'Warning', 'BackOff', `Back-off restarting failed container ${spec.name} in pod ${p.name}_${p.ns}(${p.uid})`, spec.name, true);
  }

  private startMain(p: Pod) {
    const t = p.template;
    const retry = p.status === 'ErrImagePull' || p.status === 'ImagePullBackOff';
    if (!this.pull(p, t.image, t.name, false, retry)) return;
    const env = this.resolveEnv(p.ns, t);
    const err = 'error' in env ? env.error : this.nonRootError(p, effectiveSc(t), t.image, t.name);
    if (err) {
      this.kevent(p, 'Normal', 'Pulled', `Container image "${t.image}" already present on machine and can be accessed by the pod`, t.name);
      this.kevent(p, 'Warning', 'Failed', err, t.name);
      p.status = 'CreateContainerConfigError';
      p.nextAction = this.tick + 2;
      return;
    }
    p.env = (env as { env: Record<string, string> }).env;
    this.startContainer(p);
    for (const [i, sc] of t.sidecars.entries()) {
      const st = p.sides[i];
      if (st.status === 'Running') continue;
      this.kevent(p, 'Normal', 'Pulled', `Container image "${sc.image}" already present on machine and can be accessed by the pod`, sc.name);
      this.kevent(p, 'Normal', 'Created', 'Container created', sc.name);
      this.kevent(p, 'Normal', 'Started', 'Container started', sc.name);
      st.status = 'Running'; st.ready = true; st.startedAt = this.tick;
      st.logs.push(...(IMAGES[sc.image]?.log.slice(0, 1) ?? []));
    }
  }

  private startContainer(p: Pod) {
    const name = p.template.name;
    this.kevent(p, 'Normal', 'Pulled', `Container image "${p.template.image}" already present on machine and can be accessed by the pod`, name);
    this.kevent(p, 'Normal', 'Created', 'Container created', name);
    p.status = 'Running';
    p.startedAt = this.tick;
    p.nextAction = this.tick + 1;
    p.previousLogs = p.logs;
    p.logs = [];
    // With no readiness probe a container is Ready as soon as it runs. The
    // batch images have none; the long-running ones keep their start delay.
    if (IMAGES[p.template.image]?.behaviour === 'batch') p.ready = true;
    this.kevent(p, 'Normal', 'Started', 'Container started', name);
  }

  private runContainer(p: Pod, img: Image) {
    const age = this.tick - (p.startedAt ?? this.tick);
    p.nextAction = this.tick + 1;
    if (age === 1) p.logs.push(...img.log.slice(0, 1));
    const sc = effectiveSc(p.template);
    if (sc.readOnlyRootFilesystem && img.writes && !this.mountedAt(p, img.writes)) {
      p.logs.push(`error: mkdir ${img.writes}/panda-cache: read-only file system`);
      return this.exitMain(p, 1);
    }
    if (img.needsEnv && !p.env[img.needsEnv]) {
      p.logs.push(`error: ${img.needsEnv} is not set - refusing to start without a database`);
      return this.exitMain(p, 1);
    }
    if (img.memUse > p.template.limits.mem) {
      p.logs.push(...img.log.slice(1));
      return this.terminate(p, 137, 'OOMKilled');
    }
    if (img.behaviour === 'batch') {
      p.ready = true;
      if (age >= (img.runTicks ?? 1)) { p.logs.push(...img.log.slice(1)); return this.exitMain(p, img.exitCode ?? 0); }
      return;
    }
    const started = age >= img.startTicks;
    const sp = p.template.startupProbe;
    if (!started && sp && age * SECONDS_PER_TICK >= sp.initialDelaySeconds + sp.periodSeconds * sp.failureThreshold) {
      // A startup probe that is too short kills a healthy slow starter just as
      // liveness did; the fix is sizing it, not merely adding one.
      this.kevent(p, 'Warning', 'Unhealthy', `Startup probe failed: Get "http://${p.ip}:8080/": dial tcp ${p.ip}:8080: connect: connection refused`, p.template.name);
      this.kevent(p, 'Normal', 'Killing', `Container ${p.template.name} failed startup probe, will be restarted`, p.template.name);
      return this.terminate(p, 137, 'Error');
    }
    if (!started && p.template.liveness && !sp && age >= LIVENESS_KILL) {
      // Liveness kills a process that is healthy but slow. Same 137 as the OOM
      // kill above; only the reason and these two events tell them apart.
      this.kevent(p, 'Warning', 'Unhealthy', `Liveness probe failed: Get "http://${p.ip}:8080/": dial tcp ${p.ip}:8080: connect: connection refused`, p.template.name);
      this.kevent(p, 'Normal', 'Killing', `Container ${p.template.name} failed liveness probe, will be restarted`, p.template.name);
      return this.terminate(p, 137, 'Error');
    }
    if (started && !p.ready) { p.ready = true; p.logs.push(...img.log.slice(1)); }
    if (img.behaviour === 'greeter' && age % 2 === 0) p.logs.push(`GREETING=${p.env.GREETING ?? ''}`);
    if (img.behaviour === 'reads-file' && age % 2 === 0) {
      const files = Object.entries(p.files).filter(([f]) => !f.endsWith('/'));
      p.logs.push(files.length ? files.map(([f, v]) => `${f}=${v}`).join(' ') : 'no files mounted');
    }
  }

  private mountedAt(p: Pod, dir: string) {
    return p.template.mounts.some((m) => dir === m.mountPath || dir.startsWith(m.mountPath + '/'));
  }

  /** Logs and readiness for the containers beside the main one, every tick. */
  private tickExtras(p: Pod) {
    if (p.status === 'Terminating') return;
    const running = [
      ...p.template.sidecars.map((spec, i) => ({ spec, st: p.sides[i] })),
      ...p.template.initContainers.map((spec, i) => ({ spec, st: p.inits[i] })).filter((x) => x.spec.restartPolicy === 'Always'),
    ];
    for (const { spec, st } of running) {
      if (st.status !== 'Running' || st.startedAt === undefined) continue;
      const age = this.tick - st.startedAt;
      if (IMAGES[spec.image]?.behaviour === 'serve' && age > 0 && age % 3 === 0) st.logs.push(`shipped ${age * 4} lines`);
    }
  }

  /** After the main container of a finished pod exits, native sidecars get SIGTERM; the log shipper ignores it, so it is killed after the grace period. */
  private stopSidecars(p: Pod) {
    if (p.terminalAt === undefined || this.tick < p.terminalAt) return;
    for (const st of p.inits) if (st.status === 'Running') {
      st.status = 'Terminated'; st.ready = false;
      st.last = { exitCode: 137, reason: 'Error', at: this.tick };
    }
  }

  /** The main container exited by itself. What happens next is the pod's restartPolicy. */
  private exitMain(p: Pod, code: number) {
    const rp = p.template.restartPolicy;
    if (rp === 'Always' || (rp === 'OnFailure' && code !== 0)) return this.terminate(p, code, code ? 'Error' : 'Completed');
    p.last = { exitCode: code, reason: code ? 'Error' : 'Completed', at: this.tick };
    p.ready = false;
    p.mainFinished = true;
    // A regular container beside it keeps running, so the pod never finishes
    // and neither does its Job: the "sidecar that never lets go".
    if (p.sides.some((s) => s.status === 'Running')) return;
    p.status = code ? 'Failed' : 'Succeeded';
    const natives = p.template.initContainers.some((c, i) => c.restartPolicy === 'Always' && p.inits[i].status === 'Running');
    if (natives) {
      this.kevent(p, 'Normal', 'Killing', `Stopping container ${p.template.initContainers.find((c) => c.restartPolicy === 'Always')!.name}`, p.template.initContainers.find((c) => c.restartPolicy === 'Always')!.name, true);
    }
    p.terminalAt = this.tick + (natives ? GRACE_TICKS : 0);
  }

  private terminate(p: Pod, exitCode: number, reason: Termination['reason']) {
    p.last = { exitCode, reason, at: this.tick };
    p.restarts++;
    p.ready = false;
    p.status = 'CrashLoopBackOff';
    // Real back-off doubles from 10 s to a 5 min cap. Same curve, in ticks.
    const delay = Math.min(60, 2 * 2 ** Math.min(p.restarts - 1, 5));
    p.nextAction = this.tick + delay;
    this.kevent(p, 'Warning', 'BackOff', `Back-off restarting failed container ${p.template.name} in pod ${p.name}_${p.ns}(${p.uid})`, p.template.name);
  }

  // ---- what kubectl shows ------------------------------------------------

  /** The STATUS column of kubectl get pods. */
  podStatus(p: Pod): string {
    if (p.status === 'Terminating') return 'Terminating';
    if (p.status === 'Initializing' || (p.initDone < p.template.initContainers.length && ['ContainerCreating', 'CreateContainerConfigError', 'ErrImagePull', 'ImagePullBackOff', 'Failed'].includes(p.status) && p.node)) {
      const st = p.inits[p.initDone];
      // On kind v1.36.1 a failing init container read Init:Error nearly all the
      // time, and Init:CrashLoopBackOff only now and then during the back-off.
      if (st?.last?.exitCode && st.status !== 'Running') return this.tick - st.last.at === 2 && p.status !== 'Failed' ? 'Init:CrashLoopBackOff' : 'Init:Error';
      if (p.status === 'CreateContainerConfigError' || p.status === 'ErrImagePull' || p.status === 'ImagePullBackOff') return `Init:${p.status}`;
      if (p.status === 'ContainerCreating' && p.initDone === 0 && st?.status === 'Waiting') return 'Init:0/' + p.template.initContainers.length;
      return `Init:${p.initDone}/${p.template.initContainers.length}`;
    }
    if (p.status === 'ContainerCreating' && p.template.initContainers.length && p.initDone >= p.template.initContainers.length) return 'PodInitializing';
    if (p.status === 'CrashLoopBackOff' && p.last && this.tick - p.last.at < 1) return p.last.reason;
    if (p.status === 'Succeeded') return 'Completed';
    if (p.status === 'Failed') return 'Error';
    if (p.status === 'Running' && p.mainFinished) return 'NotReady';
    return p.status;
  }

  /** READY: ready containers out of the regular ones plus native sidecars. */
  podReady(p: Pod) {
    const natives = p.template.initContainers.map((c, i) => ({ c, st: p.inits[i] })).filter((x) => x.c.restartPolicy === 'Always');
    const total = 1 + p.sides.length + natives.length;
    const ready = (p.ready ? 1 : 0) + p.sides.filter((s) => s.ready).length + natives.filter((x) => x.st.ready).length;
    return `${ready}/${total}`;
  }

  /** The pod phase describe prints as Status. */
  podPhase(p: Pod) {
    if (p.status === 'Terminating') return 'Terminating';
    // While native sidecars are being stopped the pod is still Running: on
    // kind v1.36.1 the phase stayed Running for the shipper's 30 s grace
    // period, though get pods already read 1/2 Completed.
    if ((p.status === 'Succeeded' || p.status === 'Failed') && p.terminalAt !== undefined && this.tick < p.terminalAt) return 'Running';
    if (p.status === 'Succeeded') return 'Succeeded';
    if (p.status === 'Failed') return 'Failed';
    if (p.status === 'Running' || p.status === 'CrashLoopBackOff') return 'Running';
    return 'Pending';
  }

  /** The main container's waiting reason, as its containerStatus carries it. A pod with no node has no container status at all. */
  mainWaitReason(p: Pod) {
    const t = p.template;
    if (p.status === 'Initializing' || p.initDone < t.initContainers.length) return 'PodInitializing';
    if (p.status === 'ContainerCreating') return t.initContainers.length ? 'PodInitializing' : 'ContainerCreating';
    return p.status;
  }

  totalRestarts(p: Pod) { return p.restarts + p.inits.reduce((n, s) => n + s.restarts, 0); }
}

// ---- cron --------------------------------------------------------------

const DESCRIPTORS: Record<string, string> = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

/**
 * Validate a schedule the way the API server does, with its messages (seen on
 * kind v1.36.1 for CRON_TZ, a wrong field count and 61 in the minute field).
 */
export function parseCron(schedule: string): number[][] {
  if (/(^|\s)(CRON_)?TZ=/.test(schedule)) throw new Error('cannot use TZ or CRON_TZ in schedule, use timeZone field instead');
  const expanded = DESCRIPTORS[schedule.trim()] ?? schedule;
  const fields = expanded.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`expected exactly 5 fields, found ${fields.length}: [${fields.join(' ')}]`);
  return fields.map((f, i) => {
    const [lo, hi] = RANGES[i];
    const out = new Set<number>();
    for (const part of f.split(',')) {
      const [range, stepS] = part.split('/');
      const step = stepS === undefined ? 1 : Number(stepS);
      if (!Number.isInteger(step) || step < 1) throw new Error(`failed to parse int from ${stepS}: strconv.Atoi: parsing "${stepS}": invalid syntax`);
      let a: number, b: number;
      if (range === '*' || range === '?') { a = lo; b = hi; }
      else {
        const [x, y] = range.split('-');
        a = Number(x); b = y === undefined ? (stepS === undefined ? a : hi) : Number(y);
        if (!/^\d+$/.test(x) || (y !== undefined && !/^\d+$/.test(y))) throw new Error(`failed to parse int from ${!/^\d+$/.test(x) ? x : y}: strconv.Atoi: parsing "${!/^\d+$/.test(x) ? x : y}": invalid syntax`);
        if (i === 4 && b === 7) b = 7;
        if (a < lo) throw new Error(`beginning of range (${a}) below minimum (${lo}): ${part}`);
        if (b > (i === 4 ? 7 : hi)) throw new Error(`end of range (${b}) above maximum (${hi}): ${part}`);
        if (a > b) throw new Error(`beginning of range (${a}) beyond end of range (${b}): ${part}`);
      }
      for (let v = a; v <= b; v += step) out.add(i === 4 && v === 7 ? 0 : v);
    }
    return [...out].sort((x, y) => x - y);
  });
}

/** Does the schedule fire at this minute (minutes since the Unix epoch, UTC)? */
export function cronMatches(schedule: string, minute: number) {
  let f: number[][];
  try { f = parseCron(schedule); } catch { return false; }
  const d = new Date(minute * 60000);
  const domStar = schedule.trim().split(/\s+/)[2] === '*', dowStar = schedule.trim().split(/\s+/)[4] === '*';
  const dom = f[2].includes(d.getUTCDate()), dow = f[4].includes(d.getUTCDay());
  // Standard cron: when both day fields are restricted, either may match.
  const day = domStar || dowStar ? dom && dow : dom || dow;
  return f[0].includes(d.getUTCMinutes()) && f[1].includes(d.getUTCHours()) && f[3].includes(d.getUTCMonth() + 1) && day;
}
