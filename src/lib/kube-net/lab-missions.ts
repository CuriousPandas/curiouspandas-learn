// Missions for the render lab (Helm and Kustomize) and the API lab. They judge
// what was rendered or applied, never the text typed, and each step is judged
// on something that happened, so a later step can't untick an earlier one.

import type { Mission } from '../missions.ts';
import { helmTemplate, kustomize, renderedReplicas, CHART_VALUES, type HelmInput, type Rendered, type KustomizeResult } from './render.ts';
import { applyVerdict, type Verdict } from './api.ts';
import { parse, YamlError, type Yaml } from './yaml.ts';
import { strictErrors } from './manifests.ts';

// ---- render lab -------------------------------------------------------------

export type RenderEvent =
  | { tool: 'helm'; input: HelmInput; result: Rendered }
  | { tool: 'kustomize'; overlay: string; result: KustomizeResult };
export type RenderState = { helm: HelmInput; overlay: string; events: RenderEvent[] };

export const START_OVERLAY = `resources:
- ../base
`;
export const START_VALUES = `# Your values. Anything here overrides the chart's values.yaml.
`;

export function renderHelm(s: RenderState): Rendered {
  const result = helmTemplate(s.helm);
  s.events.push({ tool: 'helm', input: { ...s.helm }, result });
  return result;
}
export function renderKustomize(s: RenderState): KustomizeResult {
  const result = kustomize(s.overlay);
  s.events.push({ tool: 'kustomize', overlay: s.overlay, result });
  return result;
}

const helms = (s: RenderState) => s.events.filter((e): e is Extract<RenderEvent, { tool: 'helm' }> => e.tool === 'helm');
const kusts = (s: RenderState) => s.events.filter((e): e is Extract<RenderEvent, { tool: 'kustomize' }> => e.tool === 'kustomize');
/** Whether the typo'd key reached the values at all, through --set or the file. */
const typoIn = (i: HelmInput) => /(^|,)replicaCont=/.test(i.set) || /^replicaCont\s*:/m.test(i.valuesFile);
type Obj = { [k: string]: Yaml };
const deployOf = (r: KustomizeResult) => (r.ok ? r.resources.find((o) => o.kind === 'Deployment') : undefined);
const imageOf = (d?: Obj) => ((((d?.spec as Obj)?.template as Obj)?.spec as Obj)?.containers as Obj[] | undefined)?.[0]?.image;

export const RENDER_MISSION: Mission<RenderState> = {
  id: 'kube-pkg-render', title: 'The value Helm ignored', xp: 70,
  setup: () => ({ helm: { release: 'shop', valuesFile: START_VALUES, set: '', schema: false }, overlay: START_OVERLAY, events: [] }),
  steps: [
    { text: 'Ask Helm for 3 replicas with the classic typo, --set replicaCont=3, and read the replicas line', hint: 'Type replicaCont=3 in the --set box, then Render', done: (s) => helms(s).some((e) => e.result.ok && typoIn(e.input) && renderedReplicas(e.result) === 1) },
    { text: 'Get the render to say replicas: 3', hint: 'The chart\'s values.yaml shows the key it reads', done: (s) => helms(s).some((e) => e.result.ok && renderedReplicas(e.result) === 3) },
    { text: 'Turn on the chart\'s values.schema.json and render the typo again', hint: 'Tick the schema box, put replicaCont=3 back, then Render', done: (s) => helms(s).some((e) => e.input.schema && !e.result.ok && typoIn(e.input) && /additional properties 'replicaCont' not allowed/.test(e.result.error)) },
    { text: 'Kustomize: write an overlay that names everything prod- and runs 3 replicas of web', hint: 'Add namePrefix: prod-  and  replicas: [{name: web, count: 3}], then Build', done: (s) => kusts(s).some((e) => { const d = deployOf(e.result); return !!d && (d.metadata as Obj).name === 'prod-web' && (d.spec as Obj).replicas === 3; }) },
    { text: 'Change the image tag to 2.0 with an images: entry, but misspell the image name. What does Kustomize say?', hint: 'images: [{name: panda/webb, newTag: "2.0"}], then Build', done: (s) => kusts(s).some((e) => e.result.ok && e.result.warnings.length > 0 && imageOf(deployOf(e.result)) === 'panda/web:1.0') },
    { text: 'Fix the name, and build until the Deployment runs panda/web:2.0', hint: 'name: panda/web', done: (s) => kusts(s).some((e) => imageOf(deployOf(e.result)) === 'panda/web:2.0') },
  ],
  debrief: 'Helm took replicaCont=3, stored it, and rendered the chart\'s default, because no template reads that key. Only a values.schema.json that forbids unknown keys turned the typo into an error. Kustomize was strict where it has a target to find, refusing a replicas entry or patch whose name matches nothing, and silent where it doesn\'t: an images entry for a name no container uses changes nothing and says nothing. Read the rendered output, not the inputs.',
};

export { CHART_VALUES };

// ---- API lab ----------------------------------------------------------------

export type ApiEvent = { apiVersion: string; kind: string; name: string; minor: number; crd: boolean; verdict: Verdict; specError?: boolean };
export type ApiState = { minor: number; crd: boolean; manifest: string; events: ApiEvent[] };

export const OLD_INGRESS = `apiVersion: networking.k8s.io/v1beta1
kind: Ingress
metadata:
  name: shop
spec:
  backend:
    serviceName: web
    servicePort: 80
`;
export const BAMBOO = `apiVersion: panda.example.com/v1
kind: Bamboo
metadata:
  name: snack
spec:
  stalks: 3
`;
export const ENDPOINTS = `apiVersion: v1
kind: Endpoints
metadata:
  name: legacy
`;

/** `kubectl apply -f old.yaml` against the lab's cluster version. */
export function applyApi(s: ApiState): Verdict {
  let doc: Yaml;
  const fail = (text: string): Verdict => ({ kind: 'unknown', lines: [{ text, kind: 'err' }] });
  try { doc = parse(s.manifest); } catch (e) { return fail(e instanceof YamlError ? `error: this sandbox could not read old.yaml, ${e.message}` : String(e)); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return fail('error: old.yaml must hold one Kubernetes object');
  const o = doc as Obj;
  const meta = (o.metadata && typeof o.metadata === 'object' ? o.metadata : {}) as Obj;
  const apiVersion = typeof o.apiVersion === 'string' ? o.apiVersion : '', kind = typeof o.kind === 'string' ? o.kind : '';
  if (!kind) return fail('error: error validating "old.yaml": error validating data: kind not set; if you choose to ignore these errors, turn validation off with --validate=false');
  if (!apiVersion) return fail('error: error validating "old.yaml": error validating data: apiVersion not set; if you choose to ignore these errors, turn validation off with --validate=false');
  const name = typeof meta.name === 'string' ? meta.name : '';
  let v = applyVerdict(apiVersion, kind, name, s.minor, s.crd);
  let specError = false;
  // A served v1 Ingress gets its spec checked, so a v1beta1 spec under a v1
  // apiVersion fails the way it does for real (strict decoding, 1.36.1).
  if ((v.kind === 'created' || v.kind === 'warned') && apiVersion === 'networking.k8s.io/v1' && kind === 'Ingress') {
    const errs = strictErrors('Ingress', doc);
    if (errs.length) { specError = true; v = { kind: 'unknown', lines: [{ text: `Error from server (BadRequest): error when creating "old.yaml": Ingress in version "v1" cannot be handled as a Ingress: strict decoding error: ${errs.join(', ')}`, kind: 'err' }] }; }
  }
  if (!name && v.kind !== 'missing' && v.kind !== 'crd-missing') return fail('error: this sandbox needs metadata.name');
  s.events.push({ apiVersion, kind, name, minor: s.minor, crd: s.crd, verdict: v, specError });
  return v;
}

const applied = (s: ApiState) => s.events;

export const API_MISSION: Mission<ApiState> = {
  id: 'kube-api-removed', title: 'no matches for kind', xp: 70,
  setup: () => ({ minor: 36, crd: false, manifest: OLD_INGRESS, events: [] }),
  steps: [
    { text: 'On Kubernetes 1.36, apply the old Ingress manifest', hint: 'Cluster 1.36, then Apply', done: (s) => applied(s).some((e) => e.minor >= 22 && e.kind === 'Ingress' && e.apiVersion === 'networking.k8s.io/v1beta1' && e.verdict.kind === 'missing') },
    { text: 'Apply the same file to a 1.21 cluster', hint: 'Pick 1.21, then Apply', done: (s) => applied(s).some((e) => e.minor === 21 && e.apiVersion === 'networking.k8s.io/v1beta1' && e.verdict.kind === 'warned') },
    { text: 'Migrate the manifest so 1.36 accepts it: the new apiVersion, and the spec fields it renamed', hint: 'apiVersion: networking.k8s.io/v1, and spec.backend becomes spec.defaultBackend.service with name and port.number', done: (s) => applied(s).some((e) => e.minor >= 22 && e.kind === 'Ingress' && e.apiVersion === 'networking.k8s.io/v1' && e.verdict.kind === 'created') },
    { text: 'Apply the Bamboo custom resource', hint: 'Load "Bamboo", then Apply', done: (s) => applied(s).some((e) => e.kind === 'Bamboo' && e.verdict.kind === 'crd-missing') },
    { text: 'Install the Bamboo CRD and apply it again', hint: 'Tick "Bamboo CRD installed", then Apply', done: (s) => applied(s).some((e) => e.kind === 'Bamboo' && e.crd && e.verdict.kind === 'created') },
    { text: 'Find an API that 1.36 still serves but warns about', hint: 'Load "Endpoints" and apply it on 1.36', done: (s) => applied(s).some((e) => e.minor === 36 && e.verdict.kind === 'warned') },
  ],
  debrief: 'The same file was a warning on 1.21 and an error on 1.36, and the error came from kubectl before anything reached the server: discovery said nobody serves that kind at that version. A custom resource fails the same way until its CRD is installed, which is why the message says "ensure CRDs are installed first". The warnings are the only notice you get, and they arrive while everything still works.',
};
