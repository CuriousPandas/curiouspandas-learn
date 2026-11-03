// A toy cluster for storage: StorageClasses, claims, volumes, pods that mount
// them, and a StatefulSet controller. It models one default kind cluster (a
// single untainted node and the local-path provisioner), because that is
// where every message here was copied from: Kubernetes 1.36.1, kubectl 1.37.2.
//
// What it leaves out, on purpose: access-mode enforcement across nodes (there
// is one node), volume expansion, snapshots, CSI attach and mount stages, and
// every StorageClass parameter. The lessons' "In the real world" callouts say so.

import { record, type Ev } from '../kube-ops/print.ts';

export const SECONDS_PER_TICK = 2;
export const NODE = 'kind-control-plane';
// The provisioner's identity as it appears in event sources. The real one
// carries its pod name and a UUID, which change with every install.
export const PROVISIONER_ID = 'rancher.io/local-path_local-path-provisioner-7dc846544d-q8n2x_4b1e6c0a-2f59-4d7e-9a43-0c6f2d1b8e75';

export type Phase = 'Pending' | 'Bound' | 'Released' | 'Available' | 'Terminating';

export type StorageClass = { name: string; provisioner: string; reclaimPolicy: 'Delete' | 'Retain'; bindingMode: 'WaitForFirstConsumer' | 'Immediate'; isDefault: boolean; created: number; byLearner: boolean };

export type Claim = {
  name: string; className: string | null; modes: string[]; size: string; phase: 'Pending' | 'Bound';
  volume?: string; created: number; deleting: boolean; events: Ev[]; selectedNode?: string; provisionAt?: number;
  /** Set when a StatefulSet's volumeClaimTemplates made it. */
  ownerSts?: string;
};

export type Volume = {
  name: string; size: string; modes: string[]; reclaim: 'Delete' | 'Retain'; status: 'Bound' | 'Released';
  claim: string; className: string; created: number; files: Map<string, string>; deleteAt?: number;
};

export type PodStatus = 'Pending' | 'ContainerCreating' | 'Running' | 'ErrImagePull' | 'ImagePullBackOff' | 'Terminating';

export type Pod = {
  name: string; image: string; claims: { volume: string; claim: string; mountPath: string }[];
  node?: string; status: PodStatus; ready: boolean; created: number; startAt?: number; goneAt?: number;
  events: Ev[]; owner?: string; ordinal?: number; revision?: number; lastSchedTry?: number;
};

export type StatefulSet = {
  name: string; replicas: number; image: string; serviceName: string; mountPath: string;
  templates: { name: string; className: string | null; modes: string[]; size: string }[];
  whenDeleted: 'Retain' | 'Delete'; whenScaled: 'Retain' | 'Delete';
  revision: number; created: number; events: Ev[]; labels: Record<string, string>;
};

export type Service = { name: string; headless: boolean; created: number };

/** Images the sandbox can run. Anything else fails to pull, the way a typo'd tag does. */
export const IMAGES = new Set(['panda/indexer:1.0', 'panda/web:1.0', 'panda/web:2.0']);

let uuidSeed = 0x5eed;
function uuid(): string {
  const h = () => { uuidSeed = (Math.imul(uuidSeed, 1664525) + 1013904223) >>> 0; return uuidSeed.toString(16).padStart(8, '0'); };
  const a = h() + h() + h() + h();
  return `${a.slice(0, 8)}-${a.slice(8, 12)}-4${a.slice(13, 16)}-a${a.slice(17, 20)}-${a.slice(20, 32)}`;
}

export class Storage {
  tick = 0;
  classes = new Map<string, StorageClass>();
  claims = new Map<string, Claim>();
  volumes = new Map<string, Volume>();
  pods = new Map<string, Pod>();
  sets = new Map<string, StatefulSet>();
  services = new Map<string, Service>();
  /** Everything the learner has written into a pod, by volume: kept for the "is the data still there" checks. */
  written: { volume: string; path: string; text: string }[] = [];

  constructor() {
    uuidSeed = 0x5eed;
    // kind's default class, exactly as `kubectl get sc` printed it on tiltdev and on a fresh kind cluster.
    this.classes.set('standard', { name: 'standard', provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete', bindingMode: 'WaitForFirstConsumer', isDefault: true, created: -2160, byLearner: false });
  }

  get seconds() { return this.tick * SECONDS_PER_TICK; }
  defaultClass() { return [...this.classes.values()].filter((c) => c.isDefault).sort((a, b) => b.created - a.created)[0]; }

  addClaim(c: Omit<Claim, 'phase' | 'created' | 'deleting' | 'events'>) {
    // The DefaultStorageClass admission plugin fills in a missing class at
    // creation. An explicit "" means "no class" and is left alone.
    const className = c.className === null ? (this.defaultClass()?.name ?? null) : c.className;
    const claim: Claim = { ...c, className, phase: 'Pending', created: this.tick, deleting: false, events: [] };
    this.claims.set(c.name, claim);
    this.claimEvents(claim);
    return claim;
  }

  addPod(p: { name: string; image: string; claims: Pod['claims']; owner?: string; ordinal?: number; revision?: number }) {
    const pod: Pod = { ...p, status: 'Pending', ready: false, created: this.tick, events: [] };
    this.pods.set(p.name, pod);
    return pod;
  }

  /** Claims in use by a pod that has been placed on a node: those the pvc-protection finalizer holds. */
  inUse(claim: string) {
    return [...this.pods.values()].some((p) => p.node && p.claims.some((c) => c.claim === claim));
  }

  deleteClaim(name: string) {
    const c = this.claims.get(name)!;
    c.deleting = true;
  }

  deletePod(name: string) {
    const p = this.pods.get(name)!;
    if (p.status === 'Terminating') return;
    // An unscheduled pod has nothing to stop; a running one takes a moment.
    if (!p.node) { this.pods.delete(name); return; }
    p.status = 'Terminating';
    p.ready = false;
    p.goneAt = this.tick + 2;
  }

  deleteSet(name: string) {
    const s = this.sets.get(name)!;
    this.sets.delete(name);
    // With the default cascade, the pods go and (by default) the claims stay.
    for (const p of this.pods.values()) if (p.owner === name) this.deletePod(p.name);
    if (s.whenDeleted === 'Delete') for (const c of this.claims.values()) if (c.ownerSts === name) this.deleteClaim(c.name);
  }

  private claimEvents(c: Claim) {
    if (c.phase !== 'Pending' || c.deleting) return;
    if (c.className === null || c.className === '') return;
    const sc = this.classes.get(c.className);
    if (!sc) record(c.events, this.tick, 'Warning', 'ProvisioningFailed', 'persistentvolume-controller', `storageclass.storage.k8s.io "${c.className}" not found`);
    else if (sc.bindingMode === 'WaitForFirstConsumer' && !c.selectedNode) {
      const waiting = [...this.pods.values()].find((p) => p.claims.some((x) => x.claim === c.name) && p.status !== 'Terminating');
      if (waiting) record(c.events, this.tick, 'Normal', 'WaitForPodScheduled', 'persistentvolume-controller', `waiting for pod ${waiting.name} to be scheduled`);
      else record(c.events, this.tick, 'Normal', 'WaitForFirstConsumer', 'persistentvolume-controller', 'waiting for first consumer to be created before binding');
    }
  }

  step(n = 1) { for (let i = 0; i < n; i++) this.once(); }

  private once() {
    this.tick++;
    const t = this.tick;
    this.statefulSetController();

    // pv controller and the provisioner.
    for (const c of this.claims.values()) {
      if (c.deleting) {
        if (this.inUse(c.name)) continue;
        this.claims.delete(c.name);
        const v = c.volume ? this.volumes.get(c.volume) : undefined;
        if (v) {
          if (v.reclaim === 'Delete') v.deleteAt = t + 1;
          else v.status = 'Released';
        }
        continue;
      }
      if (c.phase !== 'Pending') continue;
      if (t % 5 === 0) this.claimEvents(c);
      const sc = c.className ? this.classes.get(c.className) : undefined;
      if (!sc) continue;
      const wants = sc.bindingMode === 'Immediate' || !!c.selectedNode;
      if (wants && c.provisionAt === undefined) {
        c.provisionAt = t + 2;
        record(c.events, t, 'Normal', 'ExternalProvisioning', 'persistentvolume-controller', `Waiting for a volume to be created either by the external provisioner '${sc.provisioner}' or manually by the system administrator. If volume creation is delayed, please verify that the provisioner is running and correctly registered.`);
        record(c.events, t, 'Normal', 'Provisioning', PROVISIONER_ID, `External provisioner is provisioning volume for claim "default/${c.name}"`);
      }
      if (c.provisionAt !== undefined && t >= c.provisionAt) {
        const name = `pvc-${uuid()}`;
        this.volumes.set(name, { name, size: c.size, modes: c.modes, reclaim: sc.reclaimPolicy, status: 'Bound', claim: c.name, className: sc.name, created: t, files: new Map() });
        c.volume = name;
        c.phase = 'Bound';
        record(c.events, t, 'Normal', 'ProvisioningSucceeded', PROVISIONER_ID, `Successfully provisioned volume ${name}`);
      }
    }
    for (const v of this.volumes.values()) if (v.deleteAt !== undefined && t >= v.deleteAt) this.volumes.delete(v.name);

    // scheduler
    for (const p of this.pods.values()) {
      if (p.node || p.status === 'Terminating') continue;
      const why = this.unschedulable(p);
      if (why === 'wait') continue;
      if (why) {
        if (p.lastSchedTry === undefined || t - p.lastSchedTry >= 5) {
          record(p.events, t, 'Warning', 'FailedScheduling', 'default-scheduler', `0/1 nodes are available: ${why}. not found`);
          p.lastSchedTry = t;
        }
        continue;
      }
      // WaitForFirstConsumer: the scheduler picks the node, then the claim is provisioned there.
      const unbound = p.claims.map((x) => this.claims.get(x.claim)!).filter((c) => c.phase !== 'Bound');
      if (unbound.length) {
        for (const c of unbound) if (!c.selectedNode) { c.selectedNode = NODE; this.claimEvents(c); }
        continue;
      }
      p.node = NODE;
      p.status = 'ContainerCreating';
      p.startAt = t + 2;
      record(p.events, t, 'Normal', 'Scheduled', 'default-scheduler', `Successfully assigned default/${p.name} to ${NODE}`);
    }

    // kubelet
    for (const p of [...this.pods.values()]) {
      if (p.status === 'Terminating') { if (t >= (p.goneAt ?? t)) this.pods.delete(p.name); continue; }
      if (!p.node || p.startAt === undefined || t < p.startAt) continue;
      if (p.status === 'ContainerCreating' || p.status === 'ErrImagePull' || p.status === 'ImagePullBackOff') {
        if (IMAGES.has(p.image)) {
          if (p.status === 'ContainerCreating') {
            record(p.events, t, 'Normal', 'Pulled', 'kubelet', `spec.containers{app}: Container image "${p.image}" already present on machine and can be accessed by the pod`);
            record(p.events, t, 'Normal', 'Created', 'kubelet', 'spec.containers{app}: Container created');
            record(p.events, t, 'Normal', 'Started', 'kubelet', 'spec.containers{app}: Container started');
            p.status = 'Running';
            p.ready = true;
          }
        } else if ((t - p.startAt) % 5 === 0) {
          record(p.events, t, 'Normal', 'Pulling', 'kubelet', `spec.containers{app}: Pulling image "${p.image}"`);
          // Shortened: the real message goes on to quote the registry's reply.
          record(p.events, t, 'Warning', 'Failed', 'kubelet', `spec.containers{app}: Failed to pull image "${p.image}": not found`);
          p.status = p.status === 'ContainerCreating' ? 'ErrImagePull' : 'ImagePullBackOff';
          if (p.status === 'ImagePullBackOff') record(p.events, t, 'Normal', 'BackOff', 'kubelet', `spec.containers{app}: Back-off pulling image "${p.image}"`);
        }
      }
    }
  }

  /** null when it can be placed; 'wait' while a claim it needs is being provisioned for it. */
  private unschedulable(p: Pod): string | null | 'wait' {
    for (const x of p.claims) {
      const c = this.claims.get(x.claim);
      if (!c) return `persistentvolumeclaim "${x.claim}" not found`;
      if (c.deleting) return `persistentvolumeclaim "${x.claim}" is being deleted`;
      if (c.phase === 'Bound') continue;
      const sc = c.className ? this.classes.get(c.className) : undefined;
      if (!sc || sc.bindingMode === 'Immediate') return 'pod has unbound immediate PersistentVolumeClaims';
      if (c.selectedNode) return 'wait';
    }
    return null;
  }

  readyCount(set: string) { return [...this.pods.values()].filter((p) => p.owner === set && p.ready && p.status === 'Running').length; }

  /**
   * The StatefulSet controller with OrderedReady and RollingUpdate, the
   * defaults. The order of its passes is the point: it creates and health-
   * checks ordinals first and stops at the first that is not Running and
   * Ready, before it ever reaches the update pass. That is why reverting a
   * broken template does not repair the stuck pod (the docs' "Forced
   * rollback" known issue, reproduced on 1.36.1 while writing this).
   */
  private statefulSetController() {
    for (const s of this.sets.values()) {
      const pods = (i: number) => this.pods.get(`${s.name}-${i}`);
      let blocked = false;
      for (let i = 0; i < s.replicas && !blocked; i++) {
        const p = pods(i);
        if (!p) {
          const claims: Pod['claims'] = [];
          for (const tpl of s.templates) {
            const cname = `${tpl.name}-${s.name}-${i}`;
            if (!this.claims.has(cname)) {
              this.addClaim({ name: cname, className: tpl.className, modes: tpl.modes, size: tpl.size, ownerSts: s.name });
              record(s.events, this.tick, 'Normal', 'SuccessfulCreate', 'statefulset-controller', `Create Claim ${cname} Pod ${s.name}-${i} in StatefulSet ${s.name} success`);
            }
            claims.push({ volume: tpl.name, claim: cname, mountPath: s.mountPath });
          }
          this.addPod({ name: `${s.name}-${i}`, image: s.image, claims, owner: s.name, ordinal: i, revision: s.revision });
          record(s.events, this.tick, 'Normal', 'SuccessfulCreate', 'statefulset-controller', `Create Pod ${s.name}-${i} in StatefulSet ${s.name} successful`);
          blocked = true;
        } else if (p.status === 'Terminating' || !(p.status === 'Running' && p.ready)) blocked = true;
      }
      if (blocked) continue;
      // Scale down: highest ordinal first, one at a time.
      const extra = [...this.pods.values()].filter((p) => p.owner === s.name && (p.ordinal ?? 0) >= s.replicas).sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0));
      if (extra.length) {
        const top = extra[0];
        if (top.status !== 'Terminating') {
          this.deletePod(top.name);
          record(s.events, this.tick, 'Normal', 'SuccessfulDelete', 'statefulset-controller', `Delete Pod ${top.name} in StatefulSet ${s.name} successful`);
          if (s.whenScaled === 'Delete') for (const c of top.claims) { const cl = this.claims.get(c.claim); if (cl && !cl.deleting) this.deleteClaim(c.claim); }
        }
        continue;
      }
      // Rolling update: highest ordinal first, waiting for each to be Ready.
      for (let i = s.replicas - 1; i >= 0; i--) {
        const p = pods(i)!;
        if (p.revision !== s.revision) {
          if (p.status !== 'Terminating') {
            this.deletePod(p.name);
            record(s.events, this.tick, 'Normal', 'SuccessfulDelete', 'statefulset-controller', `Delete Pod ${p.name} in StatefulSet ${s.name} successful`);
          }
          break;
        }
      }
    }
  }

  /** A pod's view of its mounts: the files on the volume behind each one. */
  podFiles(pod: Pod, path: string): { volume?: Volume; rel: string } {
    for (const c of pod.claims) {
      const base = c.mountPath.replace(/\/$/, '');
      if (path === base || path.startsWith(base + '/')) {
        const claim = this.claims.get(c.claim);
        return { volume: claim?.volume ? this.volumes.get(claim.volume) : undefined, rel: path.slice(base.length + 1) };
      }
    }
    return { rel: path };
  }

  hostPath(v: Volume) { return `/var/local-path-provisioner/${v.name}_default_${v.claim}`; }
}
