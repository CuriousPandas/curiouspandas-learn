// Which apiVersion and kind a cluster serves, at a given Kubernetes version,
// and what `kubectl apply` says about a manifest that uses one.
//
// Sources, all primary:
// - Removal and "available since" versions: the Kubernetes deprecated API
//   migration guide (kubernetes.io/docs/reference/using-api/deprecation-guide/).
// - "Deprecated in" versions: each API's generated prerelease-lifecycle file in
//   the Kubernetes source at a release that still served it (v1.21.0 for the
//   v1beta1 Ingress, v1.24.0 for batch/v1beta1 and policy/v1beta1, v1.25.0 for
//   autoscaling/v2beta2, v1.31.0 for flowcontrol v1beta3).
// - The warning's wording: k8s.io/apiserver/pkg/endpoints/deprecation, v1.36.1.
// - The Endpoints and ComponentStatus warnings, and the "no matches for kind"
//   error: copied from kubectl 1.37.2 against Kubernetes 1.36.1.

export type Api = { group: string; version: string; kind: string; plural: string; since: number; deprecated?: number; removed?: number; replacement?: string; warning?: string };

const gv = (a: Api) => (a.group ? `${a.group}/${a.version}` : a.version);

export const APIS: Api[] = [
  { group: 'networking.k8s.io', version: 'v1', kind: 'Ingress', plural: 'ingresses', since: 19 },
  { group: 'networking.k8s.io', version: 'v1beta1', kind: 'Ingress', plural: 'ingresses', since: 14, deprecated: 19, removed: 22, replacement: 'networking.k8s.io/v1 Ingress' },
  { group: 'extensions', version: 'v1beta1', kind: 'Ingress', plural: 'ingresses', since: 1, deprecated: 14, removed: 22, replacement: 'networking.k8s.io/v1 Ingress' },
  { group: 'batch', version: 'v1', kind: 'CronJob', plural: 'cronjobs', since: 21 },
  { group: 'batch', version: 'v1beta1', kind: 'CronJob', plural: 'cronjobs', since: 8, deprecated: 21, removed: 25, replacement: 'batch/v1 CronJob' },
  { group: 'policy', version: 'v1', kind: 'PodDisruptionBudget', plural: 'poddisruptionbudgets', since: 21 },
  { group: 'policy', version: 'v1beta1', kind: 'PodDisruptionBudget', plural: 'poddisruptionbudgets', since: 5, deprecated: 21, removed: 25, replacement: 'policy/v1 PodDisruptionBudget' },
  { group: 'autoscaling', version: 'v2', kind: 'HorizontalPodAutoscaler', plural: 'horizontalpodautoscalers', since: 23 },
  { group: 'autoscaling', version: 'v2beta2', kind: 'HorizontalPodAutoscaler', plural: 'horizontalpodautoscalers', since: 12, deprecated: 23, removed: 26, replacement: 'autoscaling/v2 HorizontalPodAutoscaler' },
  { group: 'flowcontrol.apiserver.k8s.io', version: 'v1', kind: 'FlowSchema', plural: 'flowschemas', since: 29 },
  { group: 'flowcontrol.apiserver.k8s.io', version: 'v1beta3', kind: 'FlowSchema', plural: 'flowschemas', since: 26, deprecated: 29, removed: 32, replacement: 'flowcontrol.apiserver.k8s.io/v1 FlowSchema' },
  // Deprecated and still served on 1.36, with no removal planned in the warning.
  { group: '', version: 'v1', kind: 'Endpoints', plural: 'endpoints', since: 0, warning: 'v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice', deprecated: 33 },
  { group: 'discovery.k8s.io', version: 'v1', kind: 'EndpointSlice', plural: 'endpointslices', since: 21 },
  { group: 'apps', version: 'v1', kind: 'Deployment', plural: 'deployments', since: 9 },
];

export const VERSIONS = [21, 24, 25, 31, 36];

export const CRD = { group: 'panda.example.com', version: 'v1', kind: 'Bamboo', plural: 'bamboos' };

const KNOWN_NAMESPACED = new Set(['Ingress', 'CronJob', 'PodDisruptionBudget', 'HorizontalPodAutoscaler', 'Endpoints', 'EndpointSlice', 'Deployment', 'Bamboo']);

/** The warning the API server sends for a deprecated API, in its own format. */
export function warning(a: Api): string | null {
  if (a.warning) return a.warning;
  if (!a.deprecated) return null;
  return `${gv(a)} ${a.kind} is deprecated in v1.${a.deprecated}+${a.removed ? `, unavailable in v1.${a.removed}+` : ''}${a.replacement ? `; use ${a.replacement}` : ''}`;
}

export const served = (a: Api, minor: number) => minor >= a.since && (!a.removed || minor < a.removed);

export type Verdict = { kind: 'created' | 'warned' | 'missing' | 'crd-missing' | 'unknown'; lines: { text: string; kind: 'out' | 'err' }[] };

/**
 * `kubectl apply -f FILE` for one object. kubectl first asks the API server's
 * discovery whether it serves this group/version/kind; if not, it stops before
 * sending anything, and that is the "no matches for kind" error.
 */
export function applyVerdict(apiVersion: string, kind: string, name: string, minor: number, crdInstalled: boolean, file = 'old.yaml'): Verdict {
  const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion];
  const noMatch = (): Verdict['lines'] => [
    { text: `error: resource mapping not found for name: "${name}" namespace: "" from "${file}": no matches for kind "${kind}" in version "${apiVersion}"`, kind: 'err' },
    { text: 'ensure CRDs are installed first', kind: 'err' },
  ];
  if (group === CRD.group) {
    if (crdInstalled && version === CRD.version && kind === CRD.kind) return { kind: 'created', lines: [{ text: `${CRD.kind.toLowerCase()}.${CRD.group}/${name} created`, kind: 'out' }] };
    return { kind: 'crd-missing', lines: noMatch() };
  }
  const a = APIS.find((x) => x.group === group && x.version === version && x.kind === kind);
  if (!a) {
    const knownKind = APIS.some((x) => x.kind === kind);
    if (!knownKind) return { kind: 'unknown', lines: [{ text: `This sandbox knows ${[...new Set(APIS.map((x) => x.kind))].join(', ')} and the Bamboo custom resource. A real cluster would answer "no matches for kind" for anything it does not serve.`, kind: 'err' }] };
    return { kind: 'missing', lines: noMatch() };
  }
  if (!served(a, minor)) return { kind: 'missing', lines: noMatch() };
  const resource = `${a.plural === 'endpoints' ? 'endpoints' : a.kind.toLowerCase()}${a.group ? `.${a.group}` : ''}`;
  const created = { text: `${resource}/${name} created`, kind: 'out' as const };
  const w = a.deprecated && minor >= a.deprecated ? warning(a) : null;
  return w ? { kind: 'warned', lines: [{ text: `Warning: ${w}`, kind: 'err' }, created] } : { kind: 'created', lines: [created] };
}

export const isNamespaced = (kind: string) => KNOWN_NAMESPACED.has(kind);
