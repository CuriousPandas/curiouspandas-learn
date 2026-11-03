// `kubectl get -o yaml`: the object as the API server stores it, including the
// fields nobody wrote. That is the point of the lesson that uses it: spec is
// what you asked for, status is what the controllers last saw, and defaults,
// uid and resourceVersion appear without anyone typing them.
//
// The layout copies kubectl 1.37's: keys sorted, list items at the same
// indent as their key, timestamps and numeric strings double-quoted, strings
// that start with YAML punctuation single-quoted (`schedule: '*/1 * * * *'`).
// Shapes were compared against `-o yaml` from a kind v1.36.1 cluster.

import { EPOCH_MS, SECONDS_PER_TICK, type Cluster, type Pod, type Deployment, type ConfigMap, type Secret, type Namespace, type Job, type CronJob, type DaemonSet, type ReplicaSet, type Quota, templateHash } from './cluster.ts';
import { fmtCpu, fmtMem, type Ctr, type Template } from './spec.ts';

export const ts = (tick: number) => new Date(EPOCH_MS + tick * SECONDS_PER_TICK * 1000).toISOString().replace('.000Z', 'Z');

export function base64(s: string) {
  const bytes = new TextEncoder().encode(s);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (b === undefined ? '=' : A[(n >> 6) & 63]) + (c === undefined ? '=' : A[n & 63]);
  }
  return out;
}

export function unbase64(s: string) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = s.replace(/=+$/, '');
  if (/[^A-Za-z0-9+/]/.test(clean)) throw new Error('base64: invalid input');
  const bytes: number[] = [];
  let bits = 0, buf = 0;
  for (const ch of clean) { buf = (buf << 6) | A.indexOf(ch); bits += 6; if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 255); } }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ---- the emitter -------------------------------------------------------

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '') return '""';
  if (/^(true|false|yes|no|on|off|null|y|n|~)$/i.test(s) || /^[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?$/.test(s) || /^\d{4}-\d\d-\d\d/.test(s) || /^0x[0-9a-f]+$/i.test(s)) return `"${s}"`;
  if (/^[\s*&!|>'"%@`#,[\]{}?:-]/.test(s) || /: |\s#|:$|\s$/.test(s)) return `'${s.replace(/'/g, "''")}'`;
  return s;
}

function emit(v: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return [`${pad}[]`];
    return v.flatMap((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) {
        const inner = emitMap(item as Record<string, unknown>, indent + 2);
        return [`${pad}- ${inner[0].trimStart()}`, ...inner.slice(1)];
      }
      return [`${pad}- ${inline(item, indent + 2)}`];
    });
  }
  if (v && typeof v === 'object') return emitMap(v as Record<string, unknown>, indent);
  return [`${pad}${scalar(v)}`];
}

function inline(v: unknown, indent: number) {
  if (Array.isArray(v) && !v.length) return '[]';
  if (v && typeof v === 'object' && !Object.keys(v).length) return '{}';
  if (typeof v === 'string' && v.includes('\n')) return `|${v.endsWith('\n') ? '' : '-'}\n${v.replace(/\n$/, '').split('\n').map((l) => ' '.repeat(indent) + l).join('\n')}`;
  return scalar(v);
}

function emitMap(m: Record<string, unknown>, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const keys = Object.keys(m).filter((k) => m[k] !== undefined).sort();
  if (!keys.length) return [`${pad}{}`];
  return keys.flatMap((k) => {
    const v = m[k];
    const empty = (Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
    if (v && typeof v === 'object' && !empty) {
      // A list under a key starts at the key's own indent, kubectl style.
      return [`${pad}${k}:`, ...emit(v, Array.isArray(v) ? indent : indent + 2)];
    }
    return [`${pad}${k}: ${inline(v, indent + 2)}`];
  });
}

export function toYaml(obj: unknown) { return emit(obj, 0).join('\n'); }

export function listOf(items: unknown[]) { return { apiVersion: 'v1', items, kind: 'List', metadata: { resourceVersion: '' } }; }

// ---- objects as the API server would return them -----------------------

const rv = (c: Cluster, o: object) => String(c.version(o));

function meta(c: Cluster, o: object & { name: string; created: number }, ns: string | null, extra: Record<string, unknown> = {}) {
  return { creationTimestamp: ts(o.created), ...extra, name: o.name, ...(ns ? { namespace: ns } : {}), resourceVersion: rv(c, o), uid: c.uidOf(o) };
}

function ctrObj(cname: string, image: string, x: { env: Record<string, string>; envRefs: Ctr['envRefs']; envFrom: Ctr['envFrom']; mounts: Ctr['mounts']; sc: Ctr['sc'] }, t?: Template, restartPolicy?: string) {
  const env = [
    ...x.envRefs.map((r) => ({ name: r.name, valueFrom: { [r.kind === 'configMap' ? 'configMapKeyRef' : 'secretKeyRef']: { key: r.key, name: r.ref } } })),
    ...Object.entries(x.env).map(([name, value]) => ({ name, value })),
  ];
  const sc: Record<string, unknown> = {};
  for (const k of ['allowPrivilegeEscalation', 'privileged', 'readOnlyRootFilesystem', 'runAsNonRoot', 'runAsUser'] as const) if (x.sc[k] !== undefined) sc[k] = x.sc[k];
  if (x.sc.drop || x.sc.add) sc.capabilities = { ...(x.sc.add ? { add: x.sc.add } : {}), ...(x.sc.drop ? { drop: x.sc.drop } : {}) };
  if (x.sc.seccomp) sc.seccompProfile = { type: x.sc.seccomp };
  const probe = (p: { initialDelaySeconds: number; periodSeconds: number; failureThreshold: number }) => ({
    failureThreshold: p.failureThreshold, httpGet: { path: '/', port: 8080, scheme: 'HTTP' }, initialDelaySeconds: p.initialDelaySeconds, periodSeconds: p.periodSeconds, successThreshold: 1, timeoutSeconds: 1,
  });
  return {
    ...(env.length ? { env } : {}),
    ...(x.envFrom.length ? { envFrom: x.envFrom.map((e) => ({ [e.kind === 'configMap' ? 'configMapRef' : 'secretRef']: { name: e.name } })) } : {}),
    image, imagePullPolicy: 'IfNotPresent',
    ...(t?.liveness ? { livenessProbe: probe({ initialDelaySeconds: 5, periodSeconds: 5, failureThreshold: 2 }) } : {}),
    name: cname,
    resources: t ? { limits: { memory: fmtMem(t.limits.mem) }, requests: { cpu: fmtCpu(t.requests.cpu), memory: fmtMem(t.requests.mem) } } : {},
    ...(restartPolicy ? { restartPolicy } : {}),
    ...(Object.keys(sc).length ? { securityContext: sc } : {}),
    ...(t?.startupProbe ? { startupProbe: probe(t.startupProbe) } : {}),
    terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File',
    ...(x.mounts.length ? { volumeMounts: x.mounts.map((m) => ({ mountPath: m.mountPath, name: m.name, ...(m.subPath ? { subPath: m.subPath } : {}) })) } : {}),
  };
}

export function podSpecObj(t: Template, extra: Record<string, unknown> = {}) {
  const a = t.affinity;
  const affinity: Record<string, unknown> = {};
  if (a.nodeRequired.length) affinity.nodeAffinity = { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: a.nodeRequired.map((term) => ({ matchExpressions: term.map((e) => ({ key: e.key, operator: e.operator, ...(e.values.length ? { values: e.values } : {}) })) })) } };
  if (a.antiRequired.length || a.antiPreferred.length) affinity.podAntiAffinity = {
    ...(a.antiPreferred.length ? { preferredDuringSchedulingIgnoredDuringExecution: a.antiPreferred.map((p) => ({ podAffinityTerm: { labelSelector: { matchLabels: p.term.matchLabels }, topologyKey: p.term.topologyKey }, weight: p.weight })) } : {}),
    ...(a.antiRequired.length ? { requiredDuringSchedulingIgnoredDuringExecution: a.antiRequired.map((x) => ({ labelSelector: { matchLabels: x.matchLabels }, topologyKey: x.topologyKey })) } : {}),
  };
  const psc: Record<string, unknown> = {};
  if (t.podSc.runAsNonRoot !== undefined) psc.runAsNonRoot = t.podSc.runAsNonRoot;
  if (t.podSc.runAsUser !== undefined) psc.runAsUser = t.podSc.runAsUser;
  if (t.podSc.seccomp) psc.seccompProfile = { type: t.podSc.seccomp };
  return {
    ...(Object.keys(affinity).length ? { affinity } : {}),
    containers: [ctrObj(t.name, t.image, t, t), ...t.sidecars.map((s) => ctrObj(s.name, s.image, s))],
    dnsPolicy: 'ClusterFirst',
    ...(t.initContainers.length ? { initContainers: t.initContainers.map((s) => ctrObj(s.name, s.image, s, undefined, s.restartPolicy)) } : {}),
    ...(Object.keys(t.nodeSelector).length ? { nodeSelector: t.nodeSelector } : {}),
    restartPolicy: t.restartPolicy, schedulerName: 'default-scheduler', securityContext: psc, terminationGracePeriodSeconds: 30,
    ...(t.tolerations.length ? { tolerations: t.tolerations.map((x) => ({ ...(x.effect ? { effect: x.effect } : {}), ...(x.key ? { key: x.key } : {}), operator: x.operator, ...(x.value ? { value: x.value } : {}) })) } : {}),
    ...(t.spread.length ? { topologySpreadConstraints: t.spread.map((s) => ({ labelSelector: { matchLabels: s.matchLabels }, maxSkew: s.maxSkew, topologyKey: s.topologyKey, whenUnsatisfiable: s.whenUnsatisfiable })) } : {}),
    ...(t.volumes.length ? { volumes: t.volumes.map((v) => ({ ...(v.configMap ? { configMap: { defaultMode: 420, name: v.configMap } } : {}), ...(v.secret ? { secret: { defaultMode: 420, secretName: v.secret } } : {}), ...(v.emptyDir ? { emptyDir: {} } : {}), name: v.name })) } : {}),
    ...extra,
  };
}

const tplMeta = (t: Template) => ({ ...(Object.keys(t.annotations).length ? { annotations: t.annotations } : {}), labels: t.labels });

export function podObj(c: Cluster, p: Pod) {
  const kind = p.ownerKind;
  const owner = kind === 'ReplicaSet' ? c.replicasets.get(`${p.ns}/${p.owner}`) : kind === 'Job' ? c.jobs.get(`${p.ns}/${p.owner}`) : kind === 'DaemonSet' ? c.daemonsets.get(`${p.ns}/${p.owner}`) : undefined;
  const t = p.template;
  // Every pod gets these two from the DefaultTolerationSeconds admission plugin.
  const tolerations = [...t.tolerations.map((x) => ({ ...(x.effect ? { effect: x.effect } : {}), ...(x.key ? { key: x.key } : {}), operator: x.operator, ...(x.value ? { value: x.value } : {}) })),
    { effect: 'NoExecute', key: 'node.kubernetes.io/not-ready', operator: 'Exists', tolerationSeconds: 300 },
    { effect: 'NoExecute', key: 'node.kubernetes.io/unreachable', operator: 'Exists', tolerationSeconds: 300 }];
  const state = (s: string, ready: boolean, restarts: number, name: string, image: string) => ({
    image, name, ready, restartCount: restarts,
    state: s === 'Running' ? { running: { startedAt: ts(p.startedAt ?? p.created) } } : s === 'Terminated' ? { terminated: { exitCode: p.last?.exitCode ?? 0, reason: p.last?.reason ?? 'Completed' } } : { waiting: { reason: c.mainWaitReason(p) } },
  });
  const mainState = p.status === 'Running' && !p.mainFinished ? 'Running' : p.mainFinished || p.status === 'Succeeded' || p.status === 'Failed' ? 'Terminated' : 'Waiting';
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: {
      ...meta(c, p, p.ns, owner ? { generateName: p.name.slice(0, p.name.lastIndexOf('-') + 1) } : {}),
      labels: p.labels,
      ...(owner ? { ownerReferences: [{ apiVersion: kind === 'Job' ? 'batch/v1' : 'apps/v1', blockOwnerDeletion: true, controller: true, kind, name: p.owner, uid: c.uidOf(owner) }] } : {}),
    },
    spec: podSpecObj(t, { enableServiceLinks: true, ...(p.node ? { nodeName: p.node } : {}), preemptionPolicy: 'PreemptLowerPriority', priority: 0, serviceAccount: 'default', serviceAccountName: 'default', tolerations }),
    status: {
      // A pod the scheduler has not placed has no container statuses yet (kind
      // v1.36.1: status held only the PodScheduled condition, phase and qosClass).
      ...(p.node ? { containerStatuses: [state(mainState, p.ready, p.restarts, t.name, t.image), ...p.sides.map((s, i) => state(s.status, s.ready, s.restarts, s.name, t.sidecars[i].image))] } : {}),
      ...(p.ip ? { podIP: p.ip } : {}),
      phase: c.podPhase(p) === 'Terminating' ? 'Running' : c.podPhase(p),
      qosClass: 'Burstable',
    },
  };
}

export function deploymentObj(c: Cluster, d: Deployment) {
  const s = c.deploymentStatus(d.name, d.ns);
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { annotations: { 'deployment.kubernetes.io/revision': String(d.revision) }, ...meta(c, d, d.ns, { generation: d.history.length + 1 }), labels: d.labels },
    spec: {
      progressDeadlineSeconds: d.progressDeadlineSeconds, replicas: d.replicas, revisionHistoryLimit: 10, selector: { matchLabels: { app: d.labels.app ?? d.name } },
      strategy: { rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' }, type: 'RollingUpdate' },
      template: { metadata: tplMeta(d.template), spec: podSpecObj(d.template) },
    },
    status: {
      ...(s.available ? { availableReplicas: s.available } : {}),
      // Stored conditions, in the order the controller last moved them (kind
      // v1.36.1 printed Available, then Progressing, for a settled Deployment).
      conditions: d.conditions.map((x) => ({ lastTransitionTime: ts(x.lastTransition), lastUpdateTime: ts(x.lastUpdate), message: x.message, reason: x.reason, status: x.status, type: x.type })),
      observedGeneration: d.history.length + 1, ...(s.ready ? { readyReplicas: s.ready } : {}), replicas: s.current, ...(s.unavailable ? { unavailableReplicas: s.unavailable } : {}), ...(s.upToDate ? { updatedReplicas: s.upToDate } : {}),
    },
  };
}

export function replicaSetObj(c: Cluster, r: ReplicaSet) {
  const live = c.live(r.name, r.ns);
  return {
    apiVersion: 'apps/v1', kind: 'ReplicaSet',
    metadata: { annotations: { 'deployment.kubernetes.io/revision': String(r.revision) }, ...meta(c, r, r.ns), labels: { ...r.template.labels, 'pod-template-hash': r.hash } },
    spec: { replicas: r.replicas, selector: { matchLabels: { ...r.template.labels, 'pod-template-hash': r.hash } }, template: { metadata: { labels: { ...r.template.labels, 'pod-template-hash': r.hash } }, spec: podSpecObj(r.template) } },
    status: { replicas: live.length, readyReplicas: live.filter((p) => p.ready).length },
  };
}

export const configMapObj = (c: Cluster, m: ConfigMap) => ({ apiVersion: 'v1', data: m.data, kind: 'ConfigMap', metadata: { ...meta(c, m, m.ns), ...(Object.keys(m.labels).length ? { labels: m.labels } : {}) } });

export const secretObj = (c: Cluster, s: Secret) => ({
  apiVersion: 'v1', data: Object.fromEntries(Object.entries(s.data).map(([k, v]) => [k, base64(v)])), kind: 'Secret',
  metadata: { ...meta(c, s, s.ns), ...(Object.keys(s.labels).length ? { labels: s.labels } : {}) }, type: s.type,
});

export const namespaceObj = (c: Cluster, n: Namespace) => ({
  apiVersion: 'v1', kind: 'Namespace', metadata: { ...meta(c, n, null), labels: n.labels }, spec: { finalizers: ['kubernetes'] }, status: { phase: n.terminating ? 'Terminating' : 'Active' },
});

export const quotaObj = (c: Cluster, q: Quota) => ({
  apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta(c, q, q.ns), spec: { hard: { pods: String(q.pods) } },
  status: { hard: { pods: String(q.pods) }, used: { pods: String(c.podsIn(q.ns).filter((p) => p.status !== 'Terminating' && c.holds(p)).length) } },
});

function jobSpec(j: { template: Template; backoffLimit: number }, labels?: Record<string, string>, uid?: string) {
  return {
    backoffLimit: j.backoffLimit, completionMode: 'NonIndexed', completions: 1, manualSelector: false, parallelism: 1, podReplacementPolicy: 'TerminatingOrFailed',
    ...(uid ? { selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': uid } } } : {}), suspend: false,
    template: { metadata: labels ? { labels: { ...labels, ...j.template.labels } } : {}, spec: podSpecObj(j.template) },
  };
}

export function jobObj(c: Cluster, j: Job) {
  const s = c.jobStatus(j);
  const labels = { 'batch.kubernetes.io/controller-uid': j.uid, 'batch.kubernetes.io/job-name': j.name, 'controller-uid': j.uid, 'job-name': j.name };
  return {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { ...(j.manual ? { annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' } } : {}), ...meta(c, j, j.ns, { generation: 1 }), labels, uid: j.uid },
    spec: jobSpec(j, labels, j.uid),
    status: {
      ...(s.active ? { active: s.active } : {}), ...(j.finishedAt !== undefined && j.condition === 'Complete' ? { completionTime: ts(j.finishedAt) } : {}),
      ...(j.condition ? { conditions: [{ status: 'True', type: j.condition }] } : {}),
      ...(s.failed ? { failed: s.failed } : {}), ready: s.ready, startTime: ts(j.created), ...(s.succeeded ? { succeeded: s.succeeded } : {}), terminating: 0, uncountedTerminatedPods: {},
    },
  };
}

export function cronJobObj(c: Cluster, cj: CronJob) {
  const active = [...c.jobs.values()].filter((j) => j.ns === cj.ns && j.owner === cj.name && !j.condition && !j.manual);
  return {
    apiVersion: 'batch/v1', kind: 'CronJob', metadata: { ...meta(c, cj, cj.ns, { generation: 1 }) },
    spec: {
      concurrencyPolicy: cj.concurrencyPolicy, failedJobsHistoryLimit: cj.failedJobsHistoryLimit,
      jobTemplate: { metadata: { name: cj.name }, spec: { ...(cj.backoffLimit !== 6 ? { backoffLimit: cj.backoffLimit } : {}), template: { metadata: {}, spec: podSpecObj(cj.template) } } },
      schedule: cj.schedule, successfulJobsHistoryLimit: cj.successfulJobsHistoryLimit, suspend: cj.suspend,
    },
    status: {
      ...(active.length ? { active: active.map((j) => ({ apiVersion: 'batch/v1', kind: 'Job', name: j.name, namespace: j.ns, uid: j.uid })) } : {}),
      ...(cj.lastSchedule !== undefined ? { lastScheduleTime: ts(cj.lastSchedule - (cj.lastSchedule % 12)) } : {}),
    },
  };
}

export function daemonSetObj(c: Cluster, ds: DaemonSet) {
  const s = c.dsStatus(ds);
  return {
    apiVersion: 'apps/v1', kind: 'DaemonSet',
    metadata: { annotations: { 'deprecated.daemonset.template.generation': String(ds.generation) }, ...meta(c, ds, ds.ns, { generation: ds.generation }), ...(Object.keys(ds.labels).length ? { labels: ds.labels } : {}) },
    spec: {
      revisionHistoryLimit: 10, selector: { matchLabels: ds.template.labels },
      template: { metadata: tplMeta(ds.template), spec: podSpecObj(ds.template) },
      updateStrategy: { rollingUpdate: { maxSurge: 0, maxUnavailable: 1 }, type: 'RollingUpdate' },
    },
    status: { currentNumberScheduled: s.current, desiredNumberScheduled: s.desired, numberAvailable: s.available, numberMisscheduled: 0, numberReady: s.ready, observedGeneration: ds.generation, updatedNumberScheduled: s.upToDate },
  };
}

export function nodeObj(c: Cluster, n: Cluster['nodes'][number]) {
  return {
    apiVersion: 'v1', kind: 'Node', metadata: { ...meta(c, n, null), labels: n.labels },
    spec: { podCIDR: `10.244.${c.nodes.indexOf(n) + 1}.0/24`, ...(n.taints.length ? { taints: n.taints.map((t) => ({ effect: t.effect, key: t.key, ...(t.value ? { value: t.value } : {}) })) } : {}) },
    status: { allocatable: { cpu: fmtCpu(n.cpu), memory: fmtMem(n.mem), pods: '110' }, capacity: { cpu: fmtCpu(n.cpu), memory: fmtMem(n.mem), pods: '110' }, nodeInfo: { kubeletVersion: 'v1.36.1' } },
  };
}

export { templateHash };
