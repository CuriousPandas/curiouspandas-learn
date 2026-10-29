// A toy cluster whose *failure shapes* are faithful even where its mechanics
// are simplified. Controllers, scheduler and kubelet run as separate passes on
// every tick, the way the real ones run as separate loops, because "nobody
// calls the scheduler, it notices" is the lesson. The failures copy
// TemplateMechanics/tilt labs 09 and 10 on purpose: two crashes that both exit
// 137 for opposite reasons, and a quota refusal that only shows up as an event
// on the ReplicaSet. If the sim said "OOM" for both, the lab would teach the
// wrong reflex. tests/kube.test.ts pins each shape.

import { sha1 } from '../git/sha1.ts';

export const SECONDS_PER_TICK = 5;

export type Template = {
  image: string;
  requests: { cpu: number; mem: number };
  limits: { mem: number };
  env: Record<string, string>;
  startupProbe: boolean;
  liveness: boolean;
};

export type Deployment = { name: string; replicas: number; template: Template; revision: number; history: Template[] };
export type ReplicaSet = { name: string; owner: string; hash: string; template: Template; replicas: number; revision: number; backoffUntil: number; failures: number };
export type Termination = { exitCode: number; reason: 'OOMKilled' | 'Error' | 'Completed'; at: number };
export type PodStatus = 'Pending' | 'ContainerCreating' | 'Running' | 'CrashLoopBackOff' | 'ErrImagePull' | 'ImagePullBackOff' | 'Terminating';
export type Pod = {
  name: string; owner: string; template: Template; node?: string; status: PodStatus; ready: boolean;
  restarts: number; created: number; startedAt?: number; nextAction: number; last?: Termination; logs: string[]; previousLogs: string[];
};
export type Node = { name: string; cpu: number; mem: number };
export type KEvent = { tick: number; type: 'Normal' | 'Warning'; reason: string; object: string; message: string };

/** What each sample image *does*, so failures come from behaviour, not from scripted outcomes. */
export const IMAGES: Record<string, { startTicks: number; memUse: number; needsEnv?: string; log: string[] }> = {
  'panda/hello:1.0': { startTicks: 1, memUse: 24, log: ['listening on :8080', 'GET / 200 (hello from v1)'] },
  'panda/hello:2.0': { startTicks: 1, memUse: 26, log: ['listening on :8080', 'GET / 200 (hello from v2)'] },
  'panda/greedy:1.0': { startTicks: 1, memUse: 200, log: ['loading bamboo index into memory...', 'allocated 120Mi', 'allocated 200Mi'] },
  'panda/slowpoke:1.0': { startTicks: 12, memUse: 40, log: ['warming caches (this takes about a minute)...'] },
  'panda/needs-config:1.0': { startTicks: 1, memUse: 30, needsEnv: 'DATABASE_URL', log: ['starting'] },
};

const LIVENESS_DELAY = 3; // ticks: a 15 s initialDelay, as in lab 09
const QUOTA_BACKOFF = [2, 4, 8, 16];

export function defaultTemplate(image: string): Template {
  return { image, requests: { cpu: 100, mem: 64 }, limits: { mem: 128 }, env: {}, startupProbe: false, liveness: true };
}

function templateHash(t: Template) {
  // Kubernetes names ReplicaSets by a hash of the pod template, which is why a
  // changed image makes a *new* ReplicaSet instead of editing the old one.
  const s = sha1(new TextEncoder().encode(JSON.stringify(t)));
  return [...s].map((c) => 'bcdfghjklmnpqrstvwxz2456789'[parseInt(c, 16)]).join('').slice(0, 9);
}

export class Cluster {
  tick = 0;
  nodes: Node[];
  deployments = new Map<string, Deployment>();
  replicasets = new Map<string, ReplicaSet>();
  pods = new Map<string, Pod>();
  events: KEvent[] = [];
  quota: { name: string; pods: number } | null = null;
  private seed: number;

  constructor(opts: { nodes?: Node[]; seed?: number } = {}) {
    this.nodes = opts.nodes ?? [{ name: 'worker-1', cpu: 2000, mem: 4096 }, { name: 'worker-2', cpu: 2000, mem: 4096 }];
    this.seed = opts.seed ?? 42;
  }

  private rand() {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  private suffix(n = 5) {
    let s = '';
    for (let i = 0; i < n; i++) s += 'bcdfghjklmnpqrstvwxz2456789'[Math.floor(this.rand() * 27)];
    return s;
  }

  event(type: KEvent['type'], reason: string, object: string, message: string) {
    const last = this.events[this.events.length - 1];
    if (last && last.reason === reason && last.object === object && last.message === message) { last.tick = this.tick; return; }
    this.events.push({ tick: this.tick, type, reason, object, message });
    if (this.events.length > 300) this.events.shift();
  }

  // ---- API (what kubectl talks to) ---------------------------------------

  createDeployment(name: string, image: string, replicas = 1, patch: Partial<Template> = {}) {
    if (this.deployments.has(name)) throw new Error(`Error from server (AlreadyExists): deployments.apps "${name}" already exists`);
    const template = { ...defaultTemplate(image), ...patch };
    this.deployments.set(name, { name, replicas, template, revision: 0, history: [] });
  }

  updateTemplate(name: string, change: (t: Template) => void) {
    const d = this.deployment(name);
    const next: Template = JSON.parse(JSON.stringify(d.template));
    change(next);
    if (JSON.stringify(next) === JSON.stringify(d.template)) return false;
    d.history.push(d.template);
    d.template = next;
    return true;
  }

  deployment(name: string) {
    const d = this.deployments.get(name);
    if (!d) throw new Error(`Error from server (NotFound): deployments.apps "${name}" not found`);
    return d;
  }

  deletePod(name: string) {
    const p = this.pods.get(name);
    if (!p) throw new Error(`Error from server (NotFound): pods "${name}" not found`);
    if (p.status === 'Terminating') return;
    p.status = 'Terminating';
    p.ready = false;
    p.nextAction = this.tick + 1;
    this.event('Normal', 'Killing', `pod/${name}`, 'Stopping container app');
  }

  deleteDeployment(name: string) {
    this.deployment(name);
    this.deployments.delete(name);
    for (const rs of [...this.replicasets.values()].filter((r) => r.owner === name)) {
      this.replicasets.delete(rs.name);
      for (const p of this.podsOf(rs.name)) this.deletePod(p.name);
    }
  }

  podsOf(rs: string) { return [...this.pods.values()].filter((p) => p.owner === rs); }
  live(rs: string) { return this.podsOf(rs).filter((p) => p.status !== 'Terminating'); }

  used(node: string) {
    let cpu = 0, mem = 0;
    for (const p of this.pods.values()) if (p.node === node) { cpu += p.template.requests.cpu; mem += p.template.requests.mem; }
    return { cpu, mem };
  }

  deploymentStatus(name: string) {
    const d = this.deployment(name);
    const sets = [...this.replicasets.values()].filter((r) => r.owner === name);
    const cur = sets.find((r) => r.hash === templateHash(d.template));
    const pods = sets.flatMap((r) => this.live(r.name));
    return {
      desired: d.replicas,
      current: pods.length,
      ready: pods.filter((p) => p.ready).length,
      upToDate: cur ? this.live(cur.name).length : 0,
      available: pods.filter((p) => p.ready).length,
      replicaFailure: sets.some((r) => r.failures > 0 && this.live(r.name).length < r.replicas),
    };
  }

  // ---- the loops ---------------------------------------------------------

  step(n = 1) {
    for (let i = 0; i < n; i++) {
      this.tick++;
      this.deploymentController();
      this.replicaSetController();
      this.scheduler();
      this.kubelet();
    }
  }

  private deploymentController() {
    for (const d of this.deployments.values()) {
      const hash = templateHash(d.template);
      const name = `${d.name}-${hash}`;
      let cur = this.replicasets.get(name);
      if (!cur) {
        d.revision++;
        cur = { name, owner: d.name, hash, template: d.template, replicas: 0, revision: d.revision, backoffUntil: 0, failures: 0 };
        this.replicasets.set(name, cur);
      }
      const old = [...this.replicasets.values()].filter((r) => r.owner === d.name && r !== cur);
      if (cur.replicas === 0 && d.replicas > 0) {
        const to = old.some((r) => r.replicas > 0) ? 1 : d.replicas;
        this.event('Normal', 'ScalingReplicaSet', `deployment/${d.name}`, `Scaled up replica set ${name} from 0 to ${to}`);
      }
      const newReady = this.live(cur.name).filter((p) => p.ready).length;
      if (!old.some((r) => r.replicas > 0)) { cur.replicas = d.replicas; continue; }
      // RollingUpdate with maxSurge 1 / maxUnavailable 0: old pods leave only
      // as new ones become Ready, so a broken image stalls the rollout with the
      // old version still serving - the reason a typo in an image tag is a
      // stuck rollout and not an outage.
      cur.replicas = Math.min(d.replicas, newReady + 1);
      let keep = Math.max(0, d.replicas - newReady);
      for (const r of old.sort((a, b) => b.revision - a.revision)) {
        const want = Math.min(r.replicas, keep);
        if (want !== r.replicas) this.event('Normal', 'ScalingReplicaSet', `deployment/${d.name}`, `Scaled down replica set ${r.name} from ${r.replicas} to ${want}`);
        r.replicas = want;
        keep -= want;
      }
    }
  }

  private replicaSetController() {
    for (const rs of this.replicasets.values()) {
      const live = this.live(rs.name);
      if (live.length > rs.replicas) {
        const victims = live.sort((a, b) => Number(a.ready) - Number(b.ready) || b.created - a.created).slice(0, live.length - rs.replicas);
        for (const v of victims) this.deletePod(v.name);
        continue;
      }
      if (live.length === rs.replicas || this.tick < rs.backoffUntil) continue;
      for (let i = live.length; i < rs.replicas; i++) {
        const inNs = [...this.pods.values()].filter((p) => p.status !== 'Terminating').length;
        if (this.quota && inNs >= this.quota.pods) {
          this.event('Warning', 'FailedCreate', `replicaset/${rs.name}`,
            `Error creating: pods "${rs.name}-${this.suffix()}" is forbidden: exceeded quota: ${this.quota.name}, requested: pods=1, used: pods=${inNs}, limited: pods=${this.quota.pods}`);
          // The ReplicaSet backs off after repeated refusals, so a fixed quota
          // is not obeyed instantly - lab 10 measured minutes. Kept short here.
          rs.backoffUntil = this.tick + QUOTA_BACKOFF[Math.min(rs.failures, QUOTA_BACKOFF.length - 1)];
          rs.failures++;
          break;
        }
        const name = `${rs.name}-${this.suffix()}`;
        this.pods.set(name, { name, owner: rs.name, template: rs.template, status: 'Pending', ready: false, restarts: 0, created: this.tick, nextAction: this.tick, logs: [], previousLogs: [] });
        this.event('Normal', 'SuccessfulCreate', `replicaset/${rs.name}`, `Created pod: ${name}`);
      }
      if (this.live(rs.name).length === rs.replicas) rs.failures = 0;
    }
  }

  private scheduler() {
    for (const p of this.pods.values()) {
      if (p.node || p.status === 'Terminating') continue;
      const fits = this.nodes.filter((n) => {
        const u = this.used(n.name);
        return u.cpu + p.template.requests.cpu <= n.cpu && u.mem + p.template.requests.mem <= n.mem;
      });
      if (!fits.length) {
        const cpu = this.nodes.filter((n) => this.used(n.name).cpu + p.template.requests.cpu > n.cpu).length;
        const mem = this.nodes.filter((n) => this.used(n.name).mem + p.template.requests.mem > n.mem).length;
        const why = [cpu && `${cpu} Insufficient cpu`, mem && `${mem} Insufficient memory`].filter(Boolean).join(', ');
        this.event('Warning', 'FailedScheduling', `pod/${p.name}`, `0/${this.nodes.length} nodes are available: ${why}.`);
        continue;
      }
      const best = fits.sort((a, b) => this.used(a.name).cpu / a.cpu - this.used(b.name).cpu / b.cpu)[0];
      p.node = best.name;
      p.status = 'ContainerCreating';
      p.nextAction = this.tick + 1;
      this.event('Normal', 'Scheduled', `pod/${p.name}`, `Successfully assigned default/${p.name} to ${best.name}`);
    }
  }

  private kubelet() {
    for (const p of [...this.pods.values()]) {
      if (this.tick < p.nextAction) continue;
      const img = IMAGES[p.template.image];
      switch (p.status) {
        case 'Terminating':
          this.pods.delete(p.name);
          break;
        case 'ContainerCreating':
        case 'ErrImagePull':
        case 'ImagePullBackOff':
          if (!img) {
            const first = p.status === 'ContainerCreating';
            this.event('Warning', 'Failed', `pod/${p.name}`, `Failed to pull image "${p.template.image}": ${p.template.image.split(':')[0]}: not found`);
            p.status = first ? 'ErrImagePull' : 'ImagePullBackOff';
            p.nextAction = this.tick + (first ? 1 : 4);
            break;
          }
          this.startContainer(p);
          break;
        case 'CrashLoopBackOff':
          this.startContainer(p);
          break;
        case 'Running':
          this.runContainer(p, img);
          break;
      }
    }
  }

  private startContainer(p: Pod) {
    this.event('Normal', 'Pulled', `pod/${p.name}`, p.status === 'CrashLoopBackOff'
      ? `Container image "${p.template.image}" already present on machine`
      : `Successfully pulled image "${p.template.image}"`);
    p.status = 'Running';
    p.startedAt = this.tick;
    p.nextAction = this.tick + 1;
    p.previousLogs = p.logs;
    p.logs = [];
    this.event('Normal', 'Started', `pod/${p.name}`, 'Started container app');
  }

  private runContainer(p: Pod, img: (typeof IMAGES)[string]) {
    const age = this.tick - (p.startedAt ?? this.tick);
    p.nextAction = this.tick + 1;
    if (age === 1) p.logs.push(...img.log.slice(0, 1));
    if (img.needsEnv && !p.template.env[img.needsEnv]) {
      p.logs.push(`error: ${img.needsEnv} is not set - refusing to start without a database`);
      return this.terminate(p, 1, 'Error');
    }
    if (img.memUse > p.template.limits.mem) {
      p.logs.push(...img.log.slice(1));
      return this.terminate(p, 137, 'OOMKilled');
    }
    const started = age >= img.startTicks;
    if (!started && p.template.liveness && !p.template.startupProbe && age >= LIVENESS_DELAY) {
      // Liveness kills a process that is healthy but slow. Same 137 as the OOM
      // kill above; only the reason and these two events tell them apart.
      this.event('Warning', 'Unhealthy', `pod/${p.name}`, `Liveness probe failed: Get "http://10.244.1.7:8080/": connection refused`);
      this.event('Normal', 'Killing', `pod/${p.name}`, 'Container app failed liveness probe, will be restarted');
      return this.terminate(p, 137, 'Error');
    }
    if (started && !p.ready) { p.ready = true; p.logs.push(...img.log.slice(1)); }
  }

  private terminate(p: Pod, exitCode: number, reason: Termination['reason']) {
    p.last = { exitCode, reason, at: this.tick };
    p.restarts++;
    p.ready = false;
    p.status = 'CrashLoopBackOff';
    // Real back-off doubles from 10 s to a 5 min cap. Same curve, in ticks.
    const delay = Math.min(60, 2 * 2 ** Math.min(p.restarts - 1, 5));
    p.nextAction = this.tick + delay;
    this.event('Warning', 'BackOff', `pod/${p.name}`, 'Back-off restarting failed container app');
  }
}
