// Two ways to turn a few inputs into Kubernetes YAML: a Helm chart rendered
// with values, and a Kustomize overlay applied to a base. Small on purpose: one
// chart, one base, and only the features the lesson uses. What they print, and
// every error message, was copied from Helm 4.1.4 (`helm template`) and
// kubectl 1.37.2's built-in Kustomize v5.8.1 (`kubectl kustomize`); the tests
// in tests/kube-net-render.test.ts say which run each came from.

import { parse, parseAll, dump, YamlError, type Yaml } from './yaml.ts';

type Obj = { [k: string]: Yaml };
const isObj = (v: Yaml | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ---- Helm -------------------------------------------------------------------

export const CHART_VALUES = `replicaCount: 1
image:
  repository: panda/web
  tag: "1.0"
service:
  port: 80
`;

export const CHART_TEMPLATE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-web
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}-web
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-web
    spec:
      containers:
      - name: web
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
`;

export const CHART_SCHEMA = `{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "replicaCount": { "type": "integer", "minimum": 0 },
    "image": {
      "type": "object",
      "additionalProperties": false,
      "properties": { "repository": { "type": "string" }, "tag": { "type": "string" } }
    },
    "service": { "type": "object", "properties": { "port": { "type": "integer" } } }
  }
}`;

export type HelmInput = { release: string; valuesFile: string; set: string; schema: boolean };
export type Rendered = { ok: true; output: string; values: Obj } | { ok: false; error: string };

/**
 * --set as Helm 4.1.4 typed it in our runs: whole numbers become integers,
 * true/false booleans, null deletes, anything else (including 2.10) stays a
 * string. We did not run Helm 3, so neither this file nor the lesson says
 * what it does with 2.10.
 */
export function parseSet(set: string): { path: string[]; value: Yaml }[] {
  const out: { path: string[]; value: Yaml }[] = [];
  if (!set.trim()) return out;
  for (const part of set.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 1) throw new Error(`Error: failed parsing --set data: key "${part}" has no value`);
    const key = part.slice(0, eq), raw = part.slice(eq + 1);
    if (/[[\]\\]/.test(key)) throw new Error(`this sandbox's --set takes dotted keys like image.tag, not list indexes or escapes ("${key}")`);
    const value: Yaml = raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : /^-?(0|[1-9]\d*)$/.test(raw) ? Number(raw) : raw;
    out.push({ path: key.split('.'), value });
  }
  return out;
}

/** Helm's coalesce: maps merge key by key, anything else replaces; null removes. */
function merge(base: Obj, over: Obj): Obj {
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = merge(out[k] as Obj, v);
    else out[k] = clone(v);
  }
  return out;
}

function setPath(o: Obj, path: string[], v: Yaml) {
  let cur = o;
  for (const p of path.slice(0, -1)) {
    if (!isObj(cur[p])) cur[p] = {};
    cur = cur[p] as Obj;
  }
  if (v === null) delete cur[path[path.length - 1]];
  else cur[path[path.length - 1]] = v;
}

type SchemaNode = { type?: string; additionalProperties?: boolean; properties?: Record<string, SchemaNode>; minimum?: number };
const typeName = (v: Yaml) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v === 'object' ? 'object' : typeof v);

function validate(v: Yaml, s: SchemaNode, at: string, errs: string[]) {
  if (s.type) {
    const t = typeName(v);
    if (!(t === s.type || (s.type === 'number' && t === 'integer'))) { errs.push(`- at '${at}': got ${t}, want ${s.type}`); return; }
  }
  if (s.minimum !== undefined && typeof v === 'number' && v < s.minimum) errs.push(`- at '${at}': minimum: got ${v}, want ${s.minimum}`);
  if (isObj(v) && s.properties) {
    const extra = Object.keys(v).filter((k) => !(k in s.properties!));
    if (s.additionalProperties === false && extra.length) errs.push(`- at '${at}': additional properties ${extra.map((k) => `'${k}'`).join(', ')} not allowed`);
    for (const [k, sub] of Object.entries(s.properties)) if (k in v) validate(v[k], sub, `${at}/${k}`, errs);
  }
}

const TEMPLATE_REF = /\{\{\s*\.(Release\.Name|Values(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*\}\}/g;

export function helmTemplate(inp: HelmInput): Rendered {
  try {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(inp.release)) return { ok: false, error: `Error: invalid release name, must match regex ^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$ and the length must not be longer than 53` };
    let values = parse(CHART_VALUES) as Obj;
    let user: Yaml;
    try { user = parse(inp.valuesFile); } catch (e) { return { ok: false, error: e instanceof YamlError ? `this sandbox could not read my-values.yaml, ${e.message}` : String(e) }; }
    if (user !== null && !isObj(user)) return { ok: false, error: 'my-values.yaml must be a mapping of key: value lines' };
    if (isObj(user)) values = merge(values, user);
    for (const s of parseSet(inp.set)) setPath(values, s.path, s.value);
    if (inp.schema) {
      const errs: string[] = [];
      validate(values, JSON.parse(CHART_SCHEMA), '', errs);
      // Real, Helm 4.1.4: one line per violation under the chart's name.
      if (errs.length) return { ok: false, error: `Error: values don't meet the specifications of the schema(s) in the following chart(s):\nweb:\n${errs.join('\n')}\n` };
    }
    let missingParent = '';
    const output = CHART_TEMPLATE.replace(TEMPLATE_REF, (_m, ref: string) => {
      if (ref === 'Release.Name') return inp.release;
      const path = ref.split('.').slice(1);
      let cur: Yaml | undefined = values;
      for (let i = 0; i < path.length; i++) {
        if (!isObj(cur)) { missingParent ||= `.Values.${path.slice(0, i).join('.')}`; return ''; }
        cur = cur[path[i]];
      }
      // A missing leaf prints as nothing (measured: --set replicaCount=null
      // rendered "replicas: " with an empty value), a number as itself.
      if (cur === undefined || cur === null) return '';
      if (isObj(cur) || Array.isArray(cur)) { missingParent ||= `.${ref}`; return ''; }
      return String(cur);
    });
    if (missingParent) return { ok: false, error: `this sandbox stops here: the template reads through ${missingParent}, which your values removed or replaced. Real Helm fails with a nil pointer error at this point, or prints a Go map; either way the chart needs that value back.` };
    return { ok: true, output: `---\n# Source: web/templates/deployment.yaml\n${output}`, values };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The replica count a render produced, read back from its YAML; null if there isn't one. */
export function renderedReplicas(r: Rendered): number | string | null {
  if (!r.ok) return null;
  const m = /^ {2}replicas: (.*)$/m.exec(r.output);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : m[1];
}

// ---- Kustomize --------------------------------------------------------------

export const BASE_FILES: Record<string, string> = {
  'base/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: panda/web:1.0
        args: ["--config-from=web-settings"]
        envFrom:
        - configMapRef:
            name: web-settings
`,
  'base/configmap.yaml': `apiVersion: v1
kind: ConfigMap
metadata:
  name: web-settings
data:
  GREETING: hello
`,
  'base/kustomization.yaml': `resources:
- deployment.yaml
- configmap.yaml
`,
};

const KUSTOMIZATION_FIELDS = ['apiVersion', 'kind', 'resources', 'namePrefix', 'nameSuffix', 'replicas', 'images', 'patches', 'namespace', 'commonLabels', 'labels', 'configMapGenerator', 'secretGenerator', 'components', 'patchesStrategicMerge', 'patchesJson6902', 'generators', 'transformers', 'vars', 'replacements', 'crds', 'helmCharts', 'openapi', 'buildMetadata', 'sortOptions', 'commonAnnotations', 'generatorOptions', 'bases', 'nameReference', 'configurations', 'validators'];
const SUPPORTED = ['resources', 'namePrefix', 'nameSuffix', 'replicas', 'images', 'patches'];
const IMAGE_FIELDS = ['name', 'newName', 'newTag', 'digest', 'tagSuffix'];
const REPLICA_FIELDS = ['name', 'count'];
const PATCH_FIELDS = ['path', 'patch', 'target', 'options'];

/**
 * Kustomize decodes a kustomization with Go's encoding/json, so field names
 * match case-insensitively, a later spelling of the same field wins, and a
 * name it doesn't have is an error. All three measured on v5.8.1: `nameprefix`,
 * `newtag` and `Count` were applied, `newtag: "3.0"` after `newTag: "2.0"`
 * gave 3.0, and `bogus` failed. An earlier version of this file matched names
 * exactly, so it refused `nameprefix` with a false "unknown field" error and
 * silently dropped `newtag` and `digest`, which real Kustomize applies.
 */
function fold(o: Obj, fields: string[]): { obj: Obj } | { error: string } {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    const f = fields.find((x) => x.toLowerCase() === k.toLowerCase());
    if (!f) return { error: `error: invalid Kustomization: json: unknown field "${k}"` };
    out[f] = v;
  }
  return { obj: out };
}

type Res = { obj: Obj; original: string };
const id = (o: Obj) => `${o.kind}.${String(o.apiVersion).includes('/') ? `${String(o.apiVersion).split('/')[1]}.${String(o.apiVersion).split('/')[0]}` : String(o.apiVersion)}/${(o.metadata as Obj).name}.[noNs]`;

/** Sorted keys at every level: kubectl kustomize prints maps in key order. */
function sortKeys(v: Yaml): Yaml {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** Strategic merge for the shapes the base has: maps merge, containers merge by name, other lists replace. */
function smp(target: Yaml, patch: Yaml, key = ''): Yaml {
  if (isObj(target) && isObj(patch)) {
    const out = clone(target);
    for (const [k, v] of Object.entries(patch)) out[k] = k in out ? smp(out[k], v, k) : clone(v);
    return out;
  }
  if (Array.isArray(target) && Array.isArray(patch) && key === 'containers') {
    const out = clone(target) as Obj[];
    for (const p of patch as Obj[]) {
      const i = out.findIndex((c) => c.name === p.name);
      if (i >= 0) out[i] = smp(out[i], p) as Obj; else out.push(clone(p));
    }
    return out;
  }
  return clone(patch);
}

export type KustomizeResult = { ok: true; output: string; warnings: string[]; resources: Obj[] } | { ok: false; error: string };

export function kustomize(overlay: string): KustomizeResult {
  try { return build(overlay); } catch (e) {
    // Anything thrown here is the sandbox's fault, not the overlay's.
    return { ok: false, error: `A bug in the sandbox, not in your overlay: ${(e as Error).message}. Start over to reset.` };
  }
}

function build(overlay: string): KustomizeResult {
  let k: Yaml;
  try { k = parse(overlay); } catch (e) {
    return { ok: false, error: e instanceof YamlError ? `error: invalid Kustomization: this sandbox could not read it, ${e.message}` : String(e) };
  }
  // Real (Kustomize v5.8.1): an empty file is refused, by name.
  if (k === null) return { ok: false, error: 'error: kustomization.yaml is empty' };
  if (!isObj(k)) return { ok: false, error: 'error: invalid Kustomization: it must be a mapping of fields' };
  const top = fold(k, KUSTOMIZATION_FIELDS);
  if ('error' in top) return { ok: false, error: top.error };
  k = top.obj;
  // Every nested field is checked before anything is built, as the real
  // decoder rejects the whole file for one unknown field anywhere in it.
  for (const [list, fields] of [['images', IMAGE_FIELDS], ['replicas', REPLICA_FIELDS], ['patches', PATCH_FIELDS]] as const) {
    const items = k[list];
    if (!Array.isArray(items)) continue;
    for (let i = 0; i < items.length; i++) {
      if (!isObj(items[i])) continue;
      const f = fold(items[i] as Obj, fields);
      if ('error' in f) return { ok: false, error: f.error };
      items[i] = f.obj;
    }
  }
  for (const f of Object.keys(k)) {
    if (!SUPPORTED.includes(f)) return { ok: false, error: `Kustomize knows "${f}", but this sandbox does not model it. It handles ${SUPPORTED.join(', ')}.` };
  }
  const resources = k.resources ?? [];
  if (!Array.isArray(resources)) return { ok: false, error: 'error: invalid Kustomization: json: cannot unmarshal string into Go struct field Kustomization.resources of type []string' };
  const res: Res[] = [];
  for (const r of resources) {
    if (r !== '../base') return { ok: false, error: `error: accumulating resources: accumulation err='accumulating resources from '${r}': evalsymlink failure on '/overlay/${r}' : lstat /overlay/${r}: no such file or directory': must build at directory: not a valid directory (this sandbox has one other directory: ../base)` };
    for (const f of ['base/deployment.yaml', 'base/configmap.yaml']) for (const d of parseAll(BASE_FILES[f])) res.push({ obj: d as Obj, original: String(((d as Obj).metadata as Obj).name) });
  }
  const pre = typeof k.namePrefix === 'string' ? k.namePrefix : '', suf = typeof k.nameSuffix === 'string' ? k.nameSuffix : '';
  const named = (n: string) => res.filter((r) => r.original === n || `${pre}${r.original}${suf}` === n);
  // Patches, then images and replicas, then name changes; names in the overlay
  // may use either the base's name or the new one (both measured to work).
  for (const [i, p] of (Array.isArray(k.patches) ? k.patches : []).entries()) {
    if (!isObj(p) || typeof p.patch !== 'string') return { ok: false, error: `this sandbox's patches entries need an inline "patch: |-" (patches[${i}])` };
    if (p.target !== undefined || p.path !== undefined) return { ok: false, error: 'this sandbox applies inline strategic-merge patches only (no target: or path:)' };
    let pd: Yaml;
    try { pd = parse(p.patch); } catch (e) { return { ok: false, error: `error: this sandbox could not read patches[${i}], ${(e as Error).message}` }; }
    if (!isObj(pd) || !isObj(pd.metadata) || !pd.kind) return { ok: false, error: `error: patches[${i}] needs apiVersion, kind and metadata.name` };
    const hit = named(String(pd.metadata.name)).filter((r) => r.obj.kind === pd.kind);
    if (hit.length !== 1) {
      const pid = id(pd);
      return { ok: false, error: `error: no resource matches strategic merge patch "${pid}": no matches for Id ${pid}; failed to find unique target for patch ${pid}` };
    }
    const keep = clone(hit[0].obj.metadata);
    const body: Obj = { ...pd };
    delete body.metadata;
    hit[0].obj = smp(hit[0].obj, body) as Obj;
    hit[0].obj.metadata = keep;
  }
  const unmatchedImages: string[] = [];
  for (const [i, im] of (Array.isArray(k.images) ? k.images : []).entries()) {
    if (!isObj(im)) return { ok: false, error: `error: images[${i}] must be a mapping` };
    if (im.newTag !== undefined && typeof im.newTag !== 'string') return { ok: false, error: `error: invalid Kustomization: json: cannot unmarshal ${typeof im.newTag === 'number' ? 'number' : typeof im.newTag} into Go struct field Image.images.newTag of type string` };
    if (im.tagSuffix !== undefined) return { ok: false, error: `Kustomize knows images[${i}].tagSuffix, but this sandbox does not model it. It handles name, newName, newTag and digest.` };
    for (const f of ['name', 'newName', 'digest'] as const) if (im[f] !== undefined && typeof im[f] !== 'string') return { ok: false, error: `this sandbox needs images[${i}].${f} as text (put quotes around ${JSON.stringify(im[f])})` };
    let hit = false;
    for (const r of res) for (const c of ((((r.obj.spec as Obj)?.template as Obj)?.spec as Obj)?.containers as Obj[] | undefined) ?? []) {
      const [name, tag] = String(c.image).split(':');
      if (name !== im.name) continue;
      hit = true;
      // Measured (v5.8.1): a digest alone replaces the tag, giving
      // panda/web@sha256:...; with newTag as well, both are kept: panda/web:2.0@sha256:...
      const newName = String(im.newName ?? name);
      if (im.digest !== undefined) c.image = `${newName}${im.newTag !== undefined ? `:${im.newTag}` : ''}@${im.digest}`;
      else c.image = `${newName}:${im.newTag ?? tag}`;
    }
    // Real: an images entry whose name matches nothing is skipped, no warning.
    if (!hit) unmatchedImages.push(String(im.name));
  }
  for (const [i, rp] of (Array.isArray(k.replicas) ? k.replicas : []).entries()) {
    if (!isObj(rp)) return { ok: false, error: `error: replicas[${i}] must be a mapping` };
    if (typeof rp.count !== 'number') return { ok: false, error: `error: invalid Kustomization: json: cannot unmarshal ${typeof rp.count === 'string' ? 'string' : typeof rp.count} into Go struct field Replica.replicas.count of type int64` };
    const hit = named(String(rp.name)).filter((r) => r.obj.kind === 'Deployment');
    if (!hit.length) return { ok: false, error: `error: resource with name ${rp.name} does not match a config with the following GVK [Deployment.[noVer].[noGrp] StatefulSet.[noVer].[noGrp] ReplicaSet.[noVer].[noGrp] ReplicationController.[noVer].[noGrp]]` };
    for (const h of hit) (h.obj.spec as Obj).replicas = rp.count;
  }
  const prefix = typeof k.namePrefix === 'string' ? k.namePrefix : '';
  const suffix = typeof k.nameSuffix === 'string' ? k.nameSuffix : '';
  if (prefix || suffix) {
    const renamed = new Map<string, string>();
    for (const r of res) {
      const m = r.obj.metadata as Obj;
      const n = `${prefix}${m.name}${suffix}`;
      if (r.obj.kind === 'ConfigMap') renamed.set(String(m.name), n);
      m.name = n;
    }
    // Kustomize knows where a Deployment names a ConfigMap and follows the
    // rename there. It does not read strings it has no rule for, such as args.
    for (const r of res) for (const c of ((((r.obj.spec as Obj)?.template as Obj)?.spec as Obj)?.containers as Obj[] | undefined) ?? []) {
      for (const ef of (c.envFrom as Obj[] | undefined) ?? []) { const ref = ef.configMapRef as Obj | undefined; if (ref && renamed.has(String(ref.name))) ref.name = renamed.get(String(ref.name))!; }
    }
  }
  // Kustomize's legacy order puts ConfigMaps before Deployments.
  const order = (o: Obj) => (o.kind === 'ConfigMap' ? 0 : 1);
  const objs = res.map((r) => sortKeys(r.obj) as Obj).sort((a, b) => order(a) - order(b));
  return { ok: true, output: objs.map((o) => dump(o)).join('\n---\n') + '\n', warnings: unmatchedImages, resources: objs };
}

/** Lines in `after` that are not in `before`, by a longest-common-subsequence diff. */
export function changedLines(before: string, after: string): Set<number> {
  const a = before.split('\n'), b = after.split('\n');
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const changed = new Set<number>();
  let i = 0, j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) { i++; j++; }
    else if (i < a.length && dp[i + 1][j] >= dp[i][j + 1]) i++;
    else { changed.add(j); j++; }
  }
  return changed;
}
