// The pod template the toy cluster understands, and the one door every change
// comes through. `kubectl patch`, `kubectl apply -f` and `kubectl run
// --overrides` all land in applyPodSpec, so a field this sandbox does not
// model is refused by name in one place instead of being silently dropped in
// three. A sandbox that ignores `"tolerations"` because of a typo in a key
// would teach that tolerations do nothing.
//
// The main container keeps its flat fields (image, requests, limits, env,
// probes) because the first five lessons and their tests read them directly.
// Everything else - init containers, extra containers, volumes, placement,
// security - sits beside them.

export type Toleration = { key?: string; operator: 'Equal' | 'Exists'; value?: string; effect?: 'NoSchedule' | 'NoExecute' | 'PreferNoSchedule' };
export type Taint = { key: string; value?: string; effect: 'NoSchedule' | 'NoExecute' | 'PreferNoSchedule' };
export type Expr = { key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values: string[] };
export type PodTerm = { matchLabels: Record<string, string>; topologyKey: string };
export type Affinity = {
  nodeRequired: Expr[][];                     // OR of terms, each an AND of expressions
  antiRequired: PodTerm[];
  antiPreferred: { weight: number; term: PodTerm }[];
};
export type Spread = { maxSkew: number; topologyKey: string; whenUnsatisfiable: 'DoNotSchedule' | 'ScheduleAnyway'; matchLabels: Record<string, string> };
export type SecCtx = {
  runAsNonRoot?: boolean; runAsUser?: number; allowPrivilegeEscalation?: boolean; privileged?: boolean;
  readOnlyRootFilesystem?: boolean; drop?: string[]; add?: string[]; seccomp?: string;
};
export type EnvRef = { name: string; kind: 'configMap' | 'secret'; ref: string; key: string };
export type EnvSource = { kind: 'configMap' | 'secret'; name: string };
export type Mount = { name: string; mountPath: string; subPath?: string };
export type Volume = { name: string; configMap?: string; secret?: string; emptyDir?: true };
export type Ctr = { name: string; image: string; env: Record<string, string>; envRefs: EnvRef[]; envFrom: EnvSource[]; mounts: Mount[]; restartPolicy?: 'Always'; sc: SecCtx };
export type Probe = { initialDelaySeconds: number; periodSeconds: number; failureThreshold: number };

export type Template = {
  name: string;
  image: string;
  requests: { cpu: number; mem: number };
  limits: { mem: number };
  env: Record<string, string>;
  // The budget a startup probe gets is initialDelay + period x failures, not
  // "as long as it needs". Kept as numbers so a bare probe gets the real
  // defaults (10 s x 3 = 30 s) and fails a 60 s start exactly as a cluster would.
  startupProbe: false | Probe;
  liveness: boolean;
  envRefs: EnvRef[];
  envFrom: EnvSource[];
  mounts: Mount[];
  sc: SecCtx;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  initContainers: Ctr[];
  sidecars: Ctr[];
  volumes: Volume[];
  restartPolicy: 'Always' | 'Never' | 'OnFailure';
  nodeSelector: Record<string, string>;
  tolerations: Toleration[];
  affinity: Affinity;
  spread: Spread[];
  podSc: { runAsNonRoot?: boolean; runAsUser?: number; seccomp?: string };
};

export function defaultTemplate(image: string, extra: Partial<Template> = {}): Template {
  return {
    name: 'app', image, requests: { cpu: 100, mem: 64 }, limits: { mem: 128 }, env: {}, startupProbe: false, liveness: true,
    envRefs: [], envFrom: [], mounts: [], sc: {}, labels: {}, annotations: {}, initContainers: [], sidecars: [], volumes: [],
    restartPolicy: 'Always', nodeSelector: {}, tolerations: [], affinity: { nodeRequired: [], antiRequired: [], antiPreferred: [] },
    spread: [], podSc: {}, ...extra,
  };
}

export function emptyCtr(name: string, image: string): Ctr {
  return { name, image, env: {}, envRefs: [], envFrom: [], mounts: [], sc: {} };
}

// ---- quantities --------------------------------------------------------

export function parseCpu(v: string) {
  if (/^\d+m$/.test(v)) return parseInt(v, 10);
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  throw new Error(`error: invalid cpu quantity "${v}" (try 250m or 0.5)`);
}
export function parseMem(v: string) {
  const m = /^(\d+)(Mi|Gi)$/.exec(v);
  if (!m) throw new Error(`error: invalid memory quantity "${v}" (try 64Mi or 1Gi)`);
  return parseInt(m[1], 10) * (m[2] === 'Gi' ? 1024 : 1);
}
export const fmtMem = (n: number) => (n === 0 ? '0' : n % 1024 === 0 ? `${n / 1024}Gi` : `${n}Mi`);
export const fmtCpu = (n: number) => (n % 1000 === 0 ? String(n / 1000) : `${n}m`);

// ---- refusing what we do not model -------------------------------------

/** A validation failure; kubectl prints it as `The Deployment "x" is invalid: <field>: <detail>`. */
export class Invalid extends Error {
  field: string;
  detail: string;
  constructor(field: string, detail: string) { super(`${field}: ${detail}`); this.field = field; this.detail = detail; }
}

const refuse = (path: string) => new Error(`error: this sandbox does not model ${path}. It refuses the change rather than quietly ignoring part of it.`);

// Field names that exist in the real Pod, Container and related schemas. A
// real field we do not model is refused. A name that exists nowhere is what
// the real API server does with a typo: it warns `unknown field` and drops it
// (seen on kind v1.36.1: `Warning: unknown field "spec.template.spec.frobnicate"`
// then "patched (no change)"). That warning is easy to miss, which is a
// lesson in itself, so the sandbox copies it rather than being stricter.
const REAL_FIELDS = new Set([
  'activeDeadlineSeconds', 'affinity', 'automountServiceAccountToken', 'containers', 'dnsConfig', 'dnsPolicy', 'enableServiceLinks', 'ephemeralContainers',
  'hostAliases', 'hostIPC', 'hostNetwork', 'hostPID', 'hostUsers', 'hostname', 'imagePullSecrets', 'initContainers', 'nodeName', 'nodeSelector', 'os', 'overhead',
  'preemptionPolicy', 'priority', 'priorityClassName', 'readinessGates', 'resourceClaims', 'resources', 'restartPolicy', 'runtimeClassName', 'schedulerName',
  'schedulingGates', 'securityContext', 'serviceAccount', 'serviceAccountName', 'setHostnameAsFQDN', 'shareProcessNamespace', 'subdomain',
  'terminationGracePeriodSeconds', 'tolerations', 'topologySpreadConstraints', 'volumes',
  'args', 'command', 'env', 'envFrom', 'image', 'imagePullPolicy', 'lifecycle', 'livenessProbe', 'name', 'ports', 'readinessProbe', 'resizePolicy', 'startupProbe',
  'stdin', 'stdinOnce', 'terminationMessagePath', 'terminationMessagePolicy', 'tty', 'volumeDevices', 'volumeMounts', 'workingDir',
  'runAsGroup', 'fsGroup', 'supplementalGroups', 'seLinuxOptions', 'sysctls', 'windowsOptions', 'appArmorProfile', 'procMount',
  'nodeAffinity', 'podAffinity', 'podAntiAffinity', 'preferredDuringSchedulingIgnoredDuringExecution', 'requiredDuringSchedulingIgnoredDuringExecution',
  'tolerationSeconds', 'matchExpressions', 'matchFields', 'matchLabelKeys', 'mismatchLabelKeys', 'namespaceSelector', 'namespaces', 'minDomains',
  'nodeAffinityPolicy', 'nodeTaintsPolicy', 'hostPath', 'persistentVolumeClaim', 'projected', 'downwardAPI', 'csi', 'ephemeral', 'nfs', 'items', 'optional',
  'defaultMode', 'mountPropagation', 'subPathExpr', 'recursiveReadOnly', 'valueFrom', 'fieldRef', 'resourceFieldRef', 'prefix', 'limits', 'requests', 'claims',
  'labels', 'annotations',
]);

let warnings: string[] = [];
/** Run a change and return the API server's warnings about fields it dropped. */
export function withWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  warnings = [];
  const result = fn();
  const w = warnings;
  warnings = [];
  return { result, warnings: w };
}

function only(obj: any, path: string, allowed: string[]) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`error: ${path} must be an object`);
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue;
    if (REAL_FIELDS.has(k)) throw refuse(`${path}.${k}`);
    warnings.push(`Warning: unknown field "${path}.${k}"`);
    delete obj[k];
  }
}

const str = (v: any, path: string) => { if (typeof v !== 'string') throw new Error(`error: ${path} must be a string`); return v; };
const strMap = (v: any, path: string): Record<string, string> => {
  if (v === null) return {};
  only(v, path, Object.keys(v ?? {}));
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) out[k] = String(x);
  return out;
};

function toleration(t: any, path: string): Toleration {
  only(t, path, ['key', 'operator', 'value', 'effect', 'tolerationSeconds']);
  if (t.tolerationSeconds !== undefined) throw refuse(`${path}.tolerationSeconds`);
  const operator = t.operator ?? 'Equal';
  if (operator !== 'Equal' && operator !== 'Exists') throw new Error(`error: ${path}.operator: Unsupported value: "${operator}": supported values: "Equal", "Exists"`);
  if (t.effect !== undefined && !['NoSchedule', 'NoExecute', 'PreferNoSchedule'].includes(t.effect)) throw new Error(`error: ${path}.effect: Unsupported value: "${t.effect}"`);
  return { key: t.key, operator, value: t.value, effect: t.effect };
}

function expr(e: any, path: string): Expr {
  only(e, path, ['key', 'operator', 'values']);
  if (!['In', 'NotIn', 'Exists', 'DoesNotExist'].includes(e.operator)) throw refuse(`${path}.operator "${e.operator}"`);
  return { key: str(e.key, `${path}.key`), operator: e.operator, values: (e.values ?? []).map(String) };
}

function podTerm(t: any, path: string): PodTerm {
  only(t, path, ['labelSelector', 'topologyKey']);
  only(t.labelSelector ?? {}, `${path}.labelSelector`, ['matchLabels']);
  return { matchLabels: strMap(t.labelSelector?.matchLabels ?? {}, `${path}.labelSelector.matchLabels`), topologyKey: str(t.topologyKey, `${path}.topologyKey`) };
}

// A strategic merge patch merges these maps key by key, so patching in a
// preferred rule keeps an existing required one beside it (that is why the
// placement lesson's real-cluster step uses a JSON patch to replace it).
function affinity(a: any, path: string, cur: Affinity): Affinity {
  const out: Affinity = { nodeRequired: [], antiRequired: [], antiPreferred: [] };
  if (a === null) return out;
  Object.assign(out, cur);
  only(a, path, ['nodeAffinity', 'podAntiAffinity']);
  if (a.nodeAffinity === null) out.nodeRequired = [];
  if (a.podAntiAffinity === null) { out.antiRequired = []; out.antiPreferred = []; }
  if (a.nodeAffinity) {
    only(a.nodeAffinity, `${path}.nodeAffinity`, ['requiredDuringSchedulingIgnoredDuringExecution']);
    const req = a.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution;
    if (req) {
      only(req, `${path}.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution`, ['nodeSelectorTerms']);
      out.nodeRequired = (req.nodeSelectorTerms ?? []).map((t: any, i: number) => {
        only(t, `nodeSelectorTerms[${i}]`, ['matchExpressions']);
        return (t.matchExpressions ?? []).map((e: any, j: number) => expr(e, `nodeSelectorTerms[${i}].matchExpressions[${j}]`));
      });
    }
  }
  if (a.podAntiAffinity) {
    only(a.podAntiAffinity, `${path}.podAntiAffinity`, ['requiredDuringSchedulingIgnoredDuringExecution', 'preferredDuringSchedulingIgnoredDuringExecution']);
    const pa = a.podAntiAffinity;
    if (pa.requiredDuringSchedulingIgnoredDuringExecution !== undefined) out.antiRequired = (pa.requiredDuringSchedulingIgnoredDuringExecution ?? []).map((t: any, i: number) => podTerm(t, `podAntiAffinity.required[${i}]`));
    if (pa.preferredDuringSchedulingIgnoredDuringExecution !== undefined) out.antiPreferred = (pa.preferredDuringSchedulingIgnoredDuringExecution ?? []).map((p: any, i: number) => {
      only(p, `podAntiAffinity.preferred[${i}]`, ['weight', 'podAffinityTerm']);
      return { weight: Number(p.weight ?? 1), term: podTerm(p.podAffinityTerm, `podAntiAffinity.preferred[${i}].podAffinityTerm`) };
    });
  }
  return out;
}

function secCtx(s: any, path: string, into: SecCtx) {
  if (s === null) { for (const k of Object.keys(into)) delete (into as any)[k]; return; }
  only(s, path, ['runAsNonRoot', 'runAsUser', 'allowPrivilegeEscalation', 'privileged', 'readOnlyRootFilesystem', 'capabilities', 'seccompProfile']);
  for (const k of ['runAsNonRoot', 'allowPrivilegeEscalation', 'privileged', 'readOnlyRootFilesystem'] as const) if (s[k] !== undefined) into[k] = s[k] === null ? undefined : Boolean(s[k]);
  if (s.runAsUser !== undefined) into.runAsUser = s.runAsUser === null ? undefined : Number(s.runAsUser);
  if (s.capabilities !== undefined) {
    only(s.capabilities ?? {}, `${path}.capabilities`, ['drop', 'add']);
    into.drop = s.capabilities?.drop ?? undefined;
    into.add = s.capabilities?.add ?? undefined;
  }
  if (s.seccompProfile !== undefined) {
    only(s.seccompProfile ?? {}, `${path}.seccompProfile`, ['type']);
    into.seccomp = s.seccompProfile?.type;
  }
}

function envList(list: any[], path: string, c: { env: Record<string, string>; envRefs: EnvRef[] }) {
  for (const [i, e] of list.entries()) {
    only(e, `${path}[${i}]`, ['name', 'value', 'valueFrom']);
    const name = str(e.name, `${path}[${i}].name`);
    delete c.env[name];
    c.envRefs = c.envRefs.filter((r) => r.name !== name);
    if (e.valueFrom) {
      only(e.valueFrom, `${path}[${i}].valueFrom`, ['configMapKeyRef', 'secretKeyRef']);
      const ref = e.valueFrom.configMapKeyRef ?? e.valueFrom.secretKeyRef;
      only(ref, `${path}[${i}].valueFrom`, ['name', 'key']);
      c.envRefs.push({ name, kind: e.valueFrom.configMapKeyRef ? 'configMap' : 'secret', ref: str(ref.name, 'name'), key: str(ref.key, 'key') });
    } else if (e.value !== null) c.env[name] = String(e.value ?? '');
  }
}

function envFromList(list: any, path: string): EnvSource[] {
  if (list === null) return [];
  return list.map((e: any, i: number) => {
    only(e, `${path}[${i}]`, ['configMapRef', 'secretRef']);
    const r = e.configMapRef ?? e.secretRef;
    only(r, `${path}[${i}]`, ['name']);
    return { kind: e.configMapRef ? 'configMap' : 'secret', name: str(r.name, 'name') } as EnvSource;
  });
}

function mounts(list: any, path: string): Mount[] {
  if (list === null) return [];
  return list.map((m: any, i: number) => {
    only(m, `${path}[${i}]`, ['name', 'mountPath', 'subPath', 'readOnly']);
    return { name: str(m.name, 'name'), mountPath: str(m.mountPath, 'mountPath'), ...(m.subPath ? { subPath: String(m.subPath) } : {}) };
  });
}

/** One container entry from a patch or manifest. Strategic merge: fields not mentioned are kept. */
function container(c: any, path: string, into: Ctr | Template, isMain: boolean, isInit: boolean) {
  const allowed = ['name', 'image', 'env', 'envFrom', 'volumeMounts', 'securityContext', 'command', 'args'];
  if (isMain) allowed.push('resources', 'startupProbe', 'livenessProbe', 'ports', 'readinessProbe');
  if (isInit) allowed.push('restartPolicy');
  only(c, path, allowed);
  // Every panda image has its behaviour built in. Accepting a command would
  // mean either running something we cannot run, or ignoring it.
  if (c.command !== undefined || c.args !== undefined) throw new Error(`error: ${path}: the panda/* images have their behaviour built in, so this sandbox cannot run a command or args`);
  if (c.ports !== undefined || c.readinessProbe !== undefined) throw refuse(`${path}.${c.ports !== undefined ? 'ports' : 'readinessProbe'}`);
  if (c.image !== undefined) into.image = str(c.image, `${path}.image`);
  if (c.env !== undefined) { if (c.env === null) { into.env = {}; into.envRefs = []; } else envList(c.env, `${path}.env`, into); }
  if (c.envFrom !== undefined) into.envFrom = envFromList(c.envFrom, `${path}.envFrom`);
  if (c.volumeMounts !== undefined) into.mounts = mounts(c.volumeMounts, `${path}.volumeMounts`);
  if (c.securityContext !== undefined) secCtx(c.securityContext, `${path}.securityContext`, into.sc);
  if (isInit && c.restartPolicy !== undefined) {
    if (c.restartPolicy !== 'Always' && c.restartPolicy !== null) throw new Error(`error: ${path}.restartPolicy: Unsupported value: "${c.restartPolicy}": supported values: "Always"`);
    (into as Ctr).restartPolicy = c.restartPolicy === 'Always' ? 'Always' : undefined;
  }
  if (isMain) {
    const t = into as Template;
    // Unset fields take the API defaults, so a bare probe is as short here
    // as it is on a real cluster.
    if (c.startupProbe !== undefined) t.startupProbe = c.startupProbe === null ? false : {
      initialDelaySeconds: Number(c.startupProbe.initialDelaySeconds ?? 0),
      periodSeconds: Number(c.startupProbe.periodSeconds ?? 10),
      failureThreshold: Number(c.startupProbe.failureThreshold ?? 3),
    };
    if (c.livenessProbe !== undefined) t.liveness = c.livenessProbe !== null;
    if (c.resources !== undefined) {
      only(c.resources ?? {}, `${path}.resources`, ['limits', 'requests']);
      if (c.resources?.limits?.memory) t.limits.mem = parseMem(c.resources.limits.memory);
      if (c.resources?.requests?.memory) t.requests.mem = parseMem(c.resources.requests.memory);
      if (c.resources?.requests?.cpu) t.requests.cpu = parseCpu(String(c.resources.requests.cpu));
    }
  }
}

/**
 * Merge a pod spec (as it appears under spec.template.spec, or a Pod's spec)
 * into a template. Lists of containers merge by name, as a strategic merge
 * patch does: a name that matches nothing adds a container.
 */
export function applyPodSpec(t: Template, spec: any, path = 'spec.template.spec') {
  only(spec, path, ['containers', 'initContainers', 'volumes', 'restartPolicy', 'nodeSelector', 'tolerations', 'affinity', 'topologySpreadConstraints', 'securityContext']);
  for (const [i, c] of (spec.containers ?? []).entries()) {
    const p = `${path}.containers[${i}]`;
    only(c, p, Object.keys(c));
    const name = c.name === undefined ? undefined : str(c.name, `${p}.name`);
    if (name === undefined) throw new Error(`error: ${p}.name: Required value`);
    if (name === t.name) { container(c, p, t, true, false); continue; }
    let side = t.sidecars.find((s) => s.name === name);
    if (!side) {
      // The same validation the API server does: a new container needs an image.
      if (!c.image) throw new Invalid(`${path}.containers[${i}].image`, 'Required value');
      side = emptyCtr(name, c.image);
      t.sidecars.push(side);
    }
    container(c, p, side, false, false);
  }
  if (spec.initContainers !== undefined) {
    if (spec.initContainers === null) t.initContainers = [];
    else for (const [i, c] of spec.initContainers.entries()) {
      const p = `${path}.initContainers[${i}]`;
      const name = str(c?.name, `${p}.name`);
      let ic = t.initContainers.find((s) => s.name === name);
      if (!ic) {
        if (!c.image) throw new Invalid(`${path}.initContainers[${i}].image`, 'Required value');
        ic = emptyCtr(name, c.image);
        t.initContainers.push(ic);
      }
      container(c, p, ic, false, true);
    }
  }
  if (spec.volumes !== undefined) {
    if (spec.volumes === null) t.volumes = [];
    else for (const [i, v] of spec.volumes.entries()) {
      const p = `${path}.volumes[${i}]`;
      only(v, p, ['name', 'configMap', 'secret', 'emptyDir']);
      const vol: Volume = { name: str(v.name, `${p}.name`) };
      if (v.configMap) { only(v.configMap, `${p}.configMap`, ['name']); vol.configMap = str(v.configMap.name, `${p}.configMap.name`); }
      else if (v.secret) { only(v.secret, `${p}.secret`, ['secretName']); vol.secret = str(v.secret.secretName, `${p}.secret.secretName`); }
      else if (v.emptyDir !== undefined) vol.emptyDir = true;
      else throw refuse(`${p} with no configMap, secret or emptyDir`);
      t.volumes = [...t.volumes.filter((x) => x.name !== vol.name), vol];
    }
  }
  if (spec.restartPolicy !== undefined) {
    if (!['Always', 'Never', 'OnFailure'].includes(spec.restartPolicy)) throw new Error(`error: ${path}.restartPolicy: Unsupported value: "${spec.restartPolicy}"`);
    t.restartPolicy = spec.restartPolicy;
  }
  if (spec.nodeSelector !== undefined) {
    // A strategic merge on a map merges keys; null on a key deletes it.
    if (spec.nodeSelector === null) t.nodeSelector = {};
    else for (const [k, v] of Object.entries(spec.nodeSelector)) { if (v === null) delete t.nodeSelector[k]; else t.nodeSelector[k] = String(v); }
  }
  if (spec.tolerations !== undefined) t.tolerations = spec.tolerations === null ? [] : spec.tolerations.map((x: any, i: number) => toleration(x, `${path}.tolerations[${i}]`));
  if (spec.affinity !== undefined) t.affinity = affinity(spec.affinity, `${path}.affinity`, t.affinity);
  if (spec.topologySpreadConstraints !== undefined) {
    t.spread = spec.topologySpreadConstraints === null ? [] : spec.topologySpreadConstraints.map((s: any, i: number) => {
      const p = `${path}.topologySpreadConstraints[${i}]`;
      only(s, p, ['maxSkew', 'topologyKey', 'whenUnsatisfiable', 'labelSelector']);
      only(s.labelSelector ?? {}, `${p}.labelSelector`, ['matchLabels']);
      if (!['DoNotSchedule', 'ScheduleAnyway'].includes(s.whenUnsatisfiable)) throw new Error(`error: ${p}.whenUnsatisfiable: Unsupported value: "${s.whenUnsatisfiable}": supported values: "DoNotSchedule", "ScheduleAnyway"`);
      return { maxSkew: Number(s.maxSkew ?? 1), topologyKey: str(s.topologyKey, `${p}.topologyKey`), whenUnsatisfiable: s.whenUnsatisfiable, matchLabels: strMap(s.labelSelector?.matchLabels ?? {}, 'matchLabels') };
    });
  }
  if (spec.securityContext !== undefined) {
    if (spec.securityContext === null) t.podSc = {};
    else {
      only(spec.securityContext, `${path}.securityContext`, ['runAsNonRoot', 'runAsUser', 'seccompProfile']);
      const s = spec.securityContext;
      if (s.runAsNonRoot !== undefined) t.podSc.runAsNonRoot = s.runAsNonRoot ?? undefined;
      if (s.runAsUser !== undefined) t.podSc.runAsUser = s.runAsUser === null ? undefined : Number(s.runAsUser);
      if (s.seccompProfile !== undefined) t.podSc.seccomp = s.seccompProfile?.type;
    }
  }
}

/** A pod template's metadata: labels and annotations merge key by key. */
export function applyTemplateMeta(t: Template, meta: any, path = 'spec.template.metadata') {
  only(meta, path, ['labels', 'annotations']);
  for (const [k, v] of Object.entries(meta.labels ?? {})) { if (v === null) delete t.labels[k]; else t.labels[k] = String(v); }
  for (const [k, v] of Object.entries(meta.annotations ?? {})) { if (v === null) delete t.annotations[k]; else t.annotations[k] = String(v); }
}

// ---- matching ----------------------------------------------------------

export function tolerates(tols: Toleration[], taint: Taint) {
  return tols.some((t) => {
    if (t.effect && t.effect !== taint.effect) return false;
    if (t.operator === 'Exists') return !t.key || t.key === taint.key;
    return t.key === taint.key && (t.value ?? '') === (taint.value ?? '');
  });
}

export function matchesExpr(labels: Record<string, string>, e: Expr) {
  const has = e.key in labels;
  switch (e.operator) {
    case 'In': return has && e.values.includes(labels[e.key]);
    case 'NotIn': return !has || !e.values.includes(labels[e.key]);
    case 'Exists': return has;
    case 'DoesNotExist': return !has;
  }
}

export const matchesLabels = (labels: Record<string, string>, want: Record<string, string>) =>
  Object.entries(want).every(([k, v]) => labels[k] === v);

export function nodeAffinityOk(t: Template, nodeLabels: Record<string, string>) {
  if (!matchesLabels(nodeLabels, t.nodeSelector)) return false;
  if (!t.affinity.nodeRequired.length) return true;
  return t.affinity.nodeRequired.some((term) => term.every((e) => matchesExpr(nodeLabels, e)));
}

/** The effective security settings for the main container: container fields win over pod fields. */
export function effectiveSc(t: Template, c: SecCtx = t.sc) {
  return {
    ...c,
    runAsNonRoot: c.runAsNonRoot ?? t.podSc.runAsNonRoot,
    runAsUser: c.runAsUser ?? t.podSc.runAsUser,
    seccomp: c.seccomp ?? t.podSc.seccomp,
  };
}

// ---- Pod Security admission -------------------------------------------

// Wording copied from a kind v1.36.1 API server (kubectl run into a namespace
// labelled pod-security.kubernetes.io/enforce=restricted, 2026-11-03), with
// the container name substituted. Only the checks whose text was seen there
// are modelled; tests/kube.test.ts pins each one.
const BASELINE_CAPS = ['AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'MKNOD', 'NET_BIND_SERVICE', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT'];

export type Level = 'privileged' | 'baseline' | 'restricted';

/** Short reasons (for warnings) and long reasons (for refusals), in the order the API server lists them. */
export function psaViolations(t: Template, level: Level): { short: string; long: string }[] {
  if (level === 'privileged') return [];
  const ctrs: { name: string; sc: SecCtx }[] = [{ name: t.name, sc: t.sc }, ...t.initContainers, ...t.sidecars];
  const out: { short: string; long: string }[] = [];
  const priv = ctrs.filter((c) => c.sc.privileged);
  if (priv.length) out.push({ short: 'privileged', long: `privileged (${names(priv)} must not set securityContext.privileged=true)` });
  const badAdd = ctrs.filter((c) => (c.sc.add ?? []).some((a) => !BASELINE_CAPS.includes(a)));
  if (level === 'baseline') {
    if (badAdd.length) out.push({ short: 'non-default capabilities', long: `non-default capabilities (${names(badAdd)} must not include ${quoteList(badAdd.flatMap((c) => (c.sc.add ?? []).filter((a) => !BASELINE_CAPS.includes(a))))} in securityContext.capabilities.add)` });
    return out;
  }
  const esc = ctrs.filter((c) => c.sc.allowPrivilegeEscalation !== false);
  if (esc.length) out.push({ short: 'allowPrivilegeEscalation != false', long: `allowPrivilegeEscalation != false (${names(esc)} must set securityContext.allowPrivilegeEscalation=false)` });
  const caps = ctrs.filter((c) => !(c.sc.drop ?? []).includes('ALL') || (c.sc.add ?? []).some((a) => a !== 'NET_BIND_SERVICE'));
  if (caps.length) {
    const noDrop = ctrs.filter((c) => !(c.sc.drop ?? []).includes('ALL'));
    const addBad = ctrs.filter((c) => (c.sc.add ?? []).some((a) => a !== 'NET_BIND_SERVICE'));
    const bits: string[] = [];
    if (noDrop.length) bits.push(`${names(noDrop)} must set securityContext.capabilities.drop=["ALL"]`);
    if (addBad.length) bits.push(`${names(addBad)} must not include ${quoteList(addBad.flatMap((c) => (c.sc.add ?? []).filter((a) => a !== 'NET_BIND_SERVICE')))} in securityContext.capabilities.add`);
    out.push({ short: 'unrestricted capabilities', long: `unrestricted capabilities (${bits.join('; ')})` });
  }
  const nonRoot = ctrs.filter((c) => (c.sc.runAsNonRoot ?? t.podSc.runAsNonRoot) !== true);
  if (nonRoot.length) out.push({ short: 'runAsNonRoot != true', long: `runAsNonRoot != true (pod or ${names(nonRoot)} must set securityContext.runAsNonRoot=true)` });
  const zero = t.podSc.runAsUser === 0 || ctrs.some((c) => c.sc.runAsUser === 0);
  if (zero) out.push({ short: 'runAsUser=0', long: `runAsUser=0 (${t.podSc.runAsUser === 0 ? 'pod' : names(ctrs.filter((c) => c.sc.runAsUser === 0))} must not set runAsUser=0)` });
  const sec = ctrs.filter((c) => !['RuntimeDefault', 'Localhost'].includes(c.sc.seccomp ?? t.podSc.seccomp ?? ''));
  if (sec.length) out.push({ short: 'seccompProfile', long: `seccompProfile (pod or ${names(sec)} must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")` });
  return out;
}

function names(cs: { name: string }[]) {
  return cs.length === 1 ? `container "${cs[0].name}"` : `containers ${cs.map((c) => `"${c.name}"`).join(', ')}`;
}
const quoteList = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ');
