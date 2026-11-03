// `kubectl apply -f` for the networking sandbox: NetworkPolicy and Ingress
// manifests, checked the way the API server checks them. Unknown fields are
// refused (kubectl 1.37 asks for strict field validation by default), and the
// validation messages are the API server's own, copied from Kubernetes 1.36.1
// with `--dry-run=server`. tests/kube-net.test.ts pins each one.

import { parseAll, YamlError, type Yaml } from './yaml.ts';
import { parseCidr } from '../net/cidr.ts';
import type { Net, Selector, Peer, PolicyPort, Rule, Policy, Ingress, IngressRule } from './net.ts';

type Obj = { [k: string]: Yaml };
const isObj = (v: Yaml | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

// The fields each kind accepts, as a tree. "*" is a map of any keys to strings;
// "[]" wraps the shape of each list item.
type Shape = 'string' | 'int' | 'int-or-string' | 'bool' | '*' | { [k: string]: Shape } | ['[]', Shape];
const LABEL_SELECTOR: Shape = { matchLabels: '*', matchExpressions: ['[]', { key: 'string', operator: 'string', values: ['[]', 'string'] }] };
const PEER: Shape = { podSelector: LABEL_SELECTOR, namespaceSelector: LABEL_SELECTOR, ipBlock: { cidr: 'string', except: ['[]', 'string'] } };
const NP_PORT: Shape = { protocol: 'string', port: 'int-or-string', endPort: 'int' };
const META: Shape = { name: 'string', namespace: 'string', labels: '*', annotations: '*' };
const SHAPES: Record<string, Shape> = {
  NetworkPolicy: {
    apiVersion: 'string', kind: 'string', metadata: META,
    spec: { podSelector: LABEL_SELECTOR, policyTypes: ['[]', 'string'], ingress: ['[]', { from: ['[]', PEER], ports: ['[]', NP_PORT] }], egress: ['[]', { to: ['[]', PEER], ports: ['[]', NP_PORT] }] },
  },
  Ingress: {
    apiVersion: 'string', kind: 'string', metadata: META,
    spec: {
      ingressClassName: 'string',
      defaultBackend: { service: { name: 'string', port: { number: 'int', name: 'string' } } },
      tls: ['[]', { hosts: ['[]', 'string'], secretName: 'string' }],
      rules: ['[]', { host: 'string', http: { paths: ['[]', { path: 'string', pathType: 'string', backend: { service: { name: 'string', port: { number: 'int', name: 'string' } } } }] } }],
    },
  },
};

/** The strict-decoding complaints for a v1 NetworkPolicy or Ingress, empty if it has none. */
export function strictErrors(kind: 'NetworkPolicy' | 'Ingress', doc: Yaml): string[] {
  const out: string[] = [];
  unknownFields(doc, SHAPES[kind], '', out);
  // Measured: with two unknown fields the API server lists them sorted.
  return out.sort();
}

function unknownFields(v: Yaml, shape: Shape, path: string, out: string[]) {
  if (shape === '*') return;
  if (Array.isArray(shape)) {
    if (Array.isArray(v)) v.forEach((x, i) => unknownFields(x, shape[1], `${path}[${i}]`, out));
    return;
  }
  if (typeof shape === 'object' && isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in shape)) out.push(`unknown field "${p}"`);
      else unknownFields(x, shape[k], p, out);
    }
  }
}

/** Type errors the decoder would hit. The real messages for these are long Go-type strings; this sandbox says it plainly. */
function typeErrors(v: Yaml, shape: Shape, path: string, out: string[]) {
  if (v === null || v === undefined) return;
  if (shape === 'string' && typeof v !== 'string') out.push(`${path} must be a string here (put quotes around ${JSON.stringify(v)})`);
  else if (shape === 'int' && (typeof v !== 'number' || !Number.isInteger(v))) out.push(`${path} must be a whole number`);
  else if (shape === 'int-or-string' && typeof v !== 'string' && !(typeof v === 'number' && Number.isInteger(v))) out.push(`${path} must be a number or a port name`);
  else if (shape === '*') {
    if (!isObj(v)) out.push(`${path} must be a map of key: value`);
    // Real for a label selector's matchLabels (1.36.1); other maps get plain sandbox wording.
    else for (const [k, x] of Object.entries(v)) if (typeof x !== 'string') out.push(/(podSelector|namespaceSelector)\.matchLabels$/.test(path) ? `json: cannot unmarshal ${typeof x === 'number' ? 'number' : typeof x === 'boolean' ? 'bool' : 'object'} into Go struct field LabelSelector.${path} of type string` : `${path}.${k} must be a string (put quotes around ${JSON.stringify(x)})`);
  } else if (Array.isArray(shape)) {
    if (!Array.isArray(v)) out.push(`${path} must be a list (each item starts with "- ")`);
    else v.forEach((x, i) => typeErrors(x, shape[1], `${path}[${i}]`, out));
  } else if (typeof shape === 'object') {
    if (!isObj(v)) out.push(path === 'spec.podSelector' ? `json: cannot unmarshal ${typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : Array.isArray(v) ? 'array' : 'string'} into Go struct field NetworkPolicySpec.spec.podSelector of type v1.LabelSelector` : `${path} must be a mapping (key: value lines), not ${JSON.stringify(v)}`);
    else for (const [k, x] of Object.entries(v)) if (k in shape) typeErrors(x, shape[k], path ? `${path}.${k}` : k, out);
  }
}

export type Applied = { kind: string; name: string; ns: string; result: 'created' | 'configured' | 'unchanged' | 'error' };
export type ApplyResult = { lines: string[]; errors: string[]; applied: Applied[] };

const GROUP: Record<string, string> = { NetworkPolicy: 'networkpolicy.networking.k8s.io', Ingress: 'ingress.networking.k8s.io' };
const REMOVED: Record<string, string[]> = {
  'networking.k8s.io/v1beta1': ['Ingress', 'IngressClass'],
  'extensions/v1beta1': ['Ingress', 'NetworkPolicy', 'Deployment', 'DaemonSet', 'ReplicaSet', 'PodSecurityPolicy'],
};

export function applyManifest(net: Net, src: string, file: string, ns: string, explicitNs = false): ApplyResult {
  const res: ApplyResult = { lines: [], errors: [], applied: [] };
  let docs: Yaml[];
  try { docs = parseAll(src); } catch (e) {
    res.errors.push(e instanceof YamlError ? `error: this sandbox could not read ${file}, ${e.message}` : String(e));
    return res;
  }
  if (!docs.length) { res.errors.push(`error: no objects passed to apply`); return res; }
  for (const doc of docs) {
    if (!isObj(doc)) { res.errors.push(`error: ${file} must hold Kubernetes objects (mappings with apiVersion and kind)`); continue; }
    const apiVersion = String(doc.apiVersion ?? ''), kind = String(doc.kind ?? '');
    const meta = isObj(doc.metadata) ? doc.metadata : {};
    const name = typeof meta.name === 'string' ? meta.name : '';
    if (!kind) { res.errors.push(`error: error validating "${file}": error validating data: kind not set; if you choose to ignore these errors, turn validation off with --validate=false`); continue; }
    if (!apiVersion) { res.errors.push(`error: error validating "${file}": error validating data: apiVersion not set; if you choose to ignore these errors, turn validation off with --validate=false`); continue; }
    if (REMOVED[apiVersion]?.includes(kind) || (apiVersion !== 'networking.k8s.io/v1' && (kind === 'NetworkPolicy' || kind === 'Ingress'))) {
      // Real, kubectl 1.37.2 against 1.36.1. kubectl looks the kind up in API
      // discovery before sending anything, so the object never reaches the server.
      res.errors.push(`error: resource mapping not found for name: "${name}" namespace: "${typeof meta.namespace === 'string' ? meta.namespace : ''}" from "${file}": no matches for kind "${kind}" in version "${apiVersion}"`, 'ensure CRDs are installed first');
      continue;
    }
    if (!SHAPES[kind]) { res.errors.push(`error: this sandbox applies NetworkPolicy and Ingress objects; for a ${kind}, use the kubectl commands in help`); continue; }
    const objNs = typeof meta.namespace === 'string' ? meta.namespace : ns;
    if (!name) {
      res.errors.push('error: error when retrieving current configuration of:', `Resource: "networking.k8s.io/v1, Resource=${plural(kind)}", GroupVersionKind: "networking.k8s.io/v1, Kind=${kind}"`, `Name: "", Namespace: "${objNs}"`, `from server for: "${file}": resource name may not be empty`);
      continue;
    }
    // Only an explicit -n conflicts; without one, the object's own namespace wins.
    if (explicitNs && typeof meta.namespace === 'string' && meta.namespace !== ns) {
      res.errors.push(`error: the namespace from the provided object "${meta.namespace}" does not match the namespace "${ns}". You must pass '--namespace=${meta.namespace}' to perform this operation.`);
      continue;
    }
    if (!net.namespaces.has(objNs)) { res.errors.push(`Error from server (NotFound): error when creating "${file}": namespaces "${objNs}" not found`); continue; }
    const key = `${objNs}/${name}`;
    const exists = kind === 'NetworkPolicy' ? net.policies.get(key) : net.ingresses.get(key);
    const unknown = strictErrors(kind as 'Ingress', doc);
    if (unknown.length) {
      // Real on create. On update the real message prints the whole patch as a
      // Go map before the same tail; this sandbox shortens that part to "...".
      res.errors.push(exists
        ? `The request is invalid: patch: Invalid value: "map[...]": strict decoding error: ${unknown.join(', ')}`
        : `Error from server (BadRequest): error when creating "${file}": ${kind} in version "v1" cannot be handled as a ${kind}: strict decoding error: ${unknown.join(', ')}`);
      res.applied.push({ kind: plural(kind), name, ns: objNs, result: 'error' });
      continue;
    }
    const types: string[] = [];
    typeErrors(doc, SHAPES[kind], '', types);
    if (types.length) { res.errors.push(types[0].startsWith('json:') ? `Error from server (BadRequest): error when creating "${file}": ${kind} in version "v1" cannot be handled as a ${kind}: ${types[0]}` : `error: ${file}: ${types[0]}`); res.applied.push({ kind: plural(kind), name, ns: objNs, result: 'error' }); continue; }
    const invalid: string[] = [];
    const built = kind === 'NetworkPolicy' ? buildPolicy(doc, name, objNs, invalid) : buildIngress(doc, name, objNs, invalid);
    if (invalid.length) {
      res.errors.push(`The ${kind} "${name}" is invalid: ${invalid.join(', ')}`);
      res.applied.push({ kind: plural(kind), name, ns: objNs, result: 'error' });
      continue;
    }
    const same = exists && JSON.stringify(exists.raw) === JSON.stringify(doc);
    const created = exists ? exists.created : net.t;
    if (kind === 'NetworkPolicy') net.policies.set(key, { ...(built as Policy), created });
    else net.ingresses.set(key, { ...(built as Ingress), created });
    const result = !exists ? 'created' : same ? 'unchanged' : 'configured';
    res.lines.push(`${GROUP[kind]}/${name} ${result}`);
    res.applied.push({ kind: plural(kind), name, ns: objNs, result });
  }
  return res;
}

const plural = (k: string) => (k === 'NetworkPolicy' ? 'networkpolicies' : 'ingresses');

function selector(v: Yaml | undefined, path: string, invalid: string[]): Selector {
  if (!isObj(v)) return {};
  const s: Selector = {};
  if (isObj(v.matchLabels)) s.matchLabels = Object.fromEntries(Object.entries(v.matchLabels).map(([k, x]) => [k, String(x)]));
  if (Array.isArray(v.matchExpressions)) {
    s.matchExpressions = v.matchExpressions.map((e, i) => {
      const o = e as Obj;
      const op = String(o.operator ?? '');
      if (!['In', 'NotIn', 'Exists', 'DoesNotExist'].includes(op)) invalid.push(`${path}.matchExpressions[${i}].operator: Invalid value: "${op}": not a valid selector operator`);
      const values = Array.isArray(o.values) ? o.values.map(String) : [];
      if ((op === 'In' || op === 'NotIn') && !values.length) invalid.push(`${path}.matchExpressions[${i}].values: Required value: must be specified when \`operator\` is 'In' or 'NotIn'`);
      if ((op === 'Exists' || op === 'DoesNotExist') && values.length) invalid.push(`${path}.matchExpressions[${i}].values: Forbidden: may not be specified when \`operator\` is 'Exists' or 'DoesNotExist'`);
      return { key: String(o.key ?? ''), operator: op as 'In', values };
    });
  }
  return s;
}

function rules(list: Yaml | undefined, peerKey: 'from' | 'to', path: string, invalid: string[]): Rule[] {
  if (!Array.isArray(list)) return [];
  return list.map((r, i) => {
    const o = isObj(r) ? r : {};
    const rp = `${path}[${i}]`;
    const peers: Peer[] | null = Array.isArray(o[peerKey]) && (o[peerKey] as Yaml[]).length ? (o[peerKey] as Yaml[]).map((pv, j) => {
      const p = isObj(pv) ? pv : {};
      const pp = `${rp}.${peerKey}[${j}]`;
      if (p.ipBlock !== undefined && (p.podSelector !== undefined || p.namespaceSelector !== undefined)) invalid.push(`${pp}: Forbidden: may not specify both ipBlock and another peer`);
      if (p.ipBlock === undefined && p.podSelector === undefined && p.namespaceSelector === undefined) invalid.push(`${pp}: Required value: must specify a peer`);
      const peer: Peer = {};
      if (p.podSelector !== undefined) peer.podSelector = selector(p.podSelector, `${pp}.podSelector`, invalid);
      if (p.namespaceSelector !== undefined) peer.namespaceSelector = selector(p.namespaceSelector, `${pp}.namespaceSelector`, invalid);
      if (isObj(p.ipBlock)) {
        const cidr = String(p.ipBlock.cidr ?? '');
        try { parseCidr(cidr); if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr)) throw new Error(); } catch { invalid.push(`${pp}.ipBlock.cidr: Invalid value: "${cidr}": must be a valid CIDR value, (e.g. 10.9.8.0/24 or 2001:db8::/64)`); }
        peer.ipBlock = { cidr, except: Array.isArray(p.ipBlock.except) ? p.ipBlock.except.map(String) : [] };
      }
      return peer;
    }) : null;
    const ports: PolicyPort[] | null = Array.isArray(o.ports) && o.ports.length ? o.ports.map((pv, j) => {
      const p = isObj(pv) ? pv : {};
      const pp = `${rp}.ports[${j}]`;
      const protocol = String(p.protocol ?? 'TCP');
      if (!['TCP', 'UDP', 'SCTP'].includes(protocol)) invalid.push(`${pp}.protocol: Unsupported value: "${protocol}": supported values: "TCP", "UDP", "SCTP"`);
      // Real: a quoted number is read as a port *name*, and names need a letter.
      if (typeof p.port === 'string' && !/[a-z]/.test(p.port)) invalid.push(`${pp}.port: Invalid value: "${p.port}": must contain at least one letter (a-z)`);
      if (typeof p.port === 'number' && (p.port < 1 || p.port > 65535)) invalid.push(`${pp}.port: Invalid value: ${p.port}: must be between 1 and 65535, inclusive`);
      const port: PolicyPort = { protocol: protocol as 'TCP' };
      if (p.port !== undefined && p.port !== null) port.port = p.port as number | string;
      if (typeof p.endPort === 'number') {
        port.endPort = p.endPort;
        // Real (1.36.1): the value it prints is the port, not the endPort.
        if (typeof p.port === 'number' && p.endPort < p.port) invalid.push(`${pp}.endPort: Invalid value: ${p.port}: must be greater than or equal to \`port\``);
        // Not measured; the docs' rule, in this sandbox's words.
        if (p.port === undefined) invalid.push(`${pp}.endPort: endPort can only be defined if port is also defined (this sandbox's wording of the docs' rule)`);
      }
      return port;
    }) : null;
    return { peers, ports };
  });
}

function buildPolicy(doc: Obj, name: string, ns: string, invalid: string[]): Policy {
  const spec = isObj(doc.spec) ? doc.spec : {};
  const typesRaw = Array.isArray(spec.policyTypes) ? spec.policyTypes.map(String) : null;
  typesRaw?.forEach((t, i) => { if (t !== 'Ingress' && t !== 'Egress') invalid.push(`spec.policyTypes[${i}]: Unsupported value: "${t}": supported values: "Ingress", "Egress"`); });
  // The docs: with no policyTypes, Ingress is always set, and Egress is set
  // only if the policy has egress rules.
  const types = (typesRaw ?? ['Ingress', ...(Array.isArray(spec.egress) && spec.egress.length ? ['Egress'] : [])]) as ('Ingress' | 'Egress')[];
  return {
    name, ns, created: 0, raw: doc, types,
    podSelector: selector(spec.podSelector, 'spec.podSelector', invalid),
    ingress: rules(spec.ingress, 'from', 'spec.ingress', invalid),
    egress: rules(spec.egress, 'to', 'spec.egress', invalid),
  };
}

function buildIngress(doc: Obj, name: string, ns: string, invalid: string[]): Ingress {
  const spec = isObj(doc.spec) ? doc.spec : {};
  const rs: IngressRule[] = (Array.isArray(spec.rules) ? spec.rules : []).map((r, i) => {
    const o = isObj(r) ? r : {};
    const http = isObj(o.http) ? o.http : {};
    const paths = (Array.isArray(http.paths) ? http.paths : []).map((pv, j) => {
      const p = isObj(pv) ? pv : {};
      const pp = `spec.rules[${i}].http.paths[${j}]`;
      if (p.pathType === undefined || p.pathType === null) invalid.push(`${pp}.pathType: Required value: pathType must be specified`);
      else if (!['Exact', 'Prefix', 'ImplementationSpecific'].includes(String(p.pathType))) invalid.push(`${pp}.pathType: Unsupported value: "${p.pathType}": supported values: "Exact", "ImplementationSpecific", "Prefix"`);
      const svc = isObj(p.backend) && isObj(p.backend.service) ? p.backend.service : null;
      if (!svc) invalid.push(`${pp}.backend: Invalid value: "": resource or service backend is required`);
      const port = svc && isObj(svc.port) ? (svc.port.number ?? svc.port.name ?? '') : '';
      return { path: String(p.path ?? '/'), pathType: String(p.pathType ?? 'Prefix'), service: svc ? String(svc.name ?? '') : '', port: port as number | string };
    });
    return { host: typeof o.host === 'string' ? o.host : undefined, paths };
  });
  const tls = (Array.isArray(spec.tls) ? spec.tls : []).map((t) => {
    const o = isObj(t) ? t : {};
    return { hosts: Array.isArray(o.hosts) ? o.hosts.map(String) : [], secretName: typeof o.secretName === 'string' ? o.secretName : undefined };
  });
  return { name, ns, created: 0, raw: doc, className: typeof spec.ingressClassName === 'string' ? spec.ingressClassName : null, rules: rs, tls, address: '' };
}
