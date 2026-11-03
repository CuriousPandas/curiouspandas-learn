// kubectl for the toy cluster. Commands, columns and messages copy kubectl
// 1.37.2 talking to a kind v1.36.1 cluster (2026-11-03), so muscle memory
// transfers: a learner who types `kubectl describe pod` here should find the
// same Events table on a real one. tests/kube.test.ts pins each copied line.
//
// Every flag a command does not understand is refused by name. A sandbox that
// quietly ignored `-n shop` would show the default namespace and teach the
// learner that their namespace is empty, which is the very mistake the
// namespaces lesson exists to fix.

import {
  Cluster, SECONDS_PER_TICK, EPOCH_MS, LIVENESS, key, clone, parseCron, templateHash,
  type Pod, type Node, type Deployment, type Job, type CronJob, type DaemonSet, type KEvent,
} from './cluster.ts';
import {
  applyPodSpec, applyTemplateMeta, defaultTemplate, fmtMem, fmtCpu, parseCpu, parseMem, psaViolations, withWarnings, Invalid,
  type Template, type Level,
} from './spec.ts';
import {
  toYaml, listOf, podObj, deploymentObj, replicaSetObj, configMapObj, secretObj, namespaceObj, quotaObj, jobObj, cronJobObj, daemonSetObj, nodeObj, unbase64,
} from './yaml.ts';
import { tokenize } from '../git/shell.ts';

export type Out = { text: string; kind: 'out' | 'err' | 'dim' };
export type Seen = { verb: string; kind?: string; name?: string; ns?: string; allNs?: boolean; pod?: Pod; output?: string; selector?: string; container?: string; previous?: boolean; text?: string;
  /** Filled in by the mission runner: when it was seen, in what order, and the pod as it was then. */
  tick?: number; seq?: number; podStatus?: string; podNode?: string; files?: Record<string, string> };
export type Observer = (cmd: Seen) => void;
/** Files a mission puts in the sandbox's working directory, for `cat` and `kubectl apply -f`. */
export type Files = Record<string, unknown>;

/** kubectl's HumanDuration: 107s, 2m31s, 64m, 3h5m, 2d. */
export function human(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  if (m < 180) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 8) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
const age = (c: Cluster, since: number) => human((c.tick - since) * SECONDS_PER_TICK);

/**
 * kubectl describe writes through Go's tabwriter: a run of consecutive lines
 * that contain a tab is one block, and each column in it is padded to its
 * widest cell plus two. A line with no tab ends the block, which is why the
 * Limits lines of a container are aligned on their own and the Requests
 * lines line up with everything below them.
 */
export function tabw(text: string): string {
  const ls = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < ls.length;) {
    if (!ls[i].includes('\t')) { out.push(ls[i++]); continue; }
    let j = i;
    while (j < ls.length && ls[j].includes('\t')) j++;
    const rows = ls.slice(i, j).map((l) => l.split('\t'));
    const w: number[] = [];
    for (const r of rows) r.slice(0, -1).forEach((c, k) => { w[k] = Math.max(w[k] ?? 0, c.length); });
    for (const r of rows) out.push(r.map((c, k) => (k < r.length - 1 ? c.padEnd(w[k] + 2) : c)).join(''));
    i = j;
  }
  return out.join('\n');
}

/** How describe prints a time: Go's "Mon, 02 Jan 2006 15:04:05 -0700", here always UTC. */
export function stamp(c: Cluster, tick: number) {
  const d = new Date(EPOCH_MS + tick * SECONDS_PER_TICK * 1000);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p2 = (n: number) => String(n).padStart(2, '0');
  void c;
  return `${day}, ${p2(d.getUTCDate())} ${mon} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
}

function table(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i] + 3))).join('').trimEnd()).join('\n');
}

// ---- resource names ------------------------------------------------------

type KindInfo = { plural: string; group: string; short?: string; namespaced: boolean; kind: string; version: string };
const KIND_INFO: KindInfo[] = [
  { plural: 'configmaps', group: '', short: 'cm', namespaced: true, kind: 'ConfigMap', version: 'v1' },
  { plural: 'events', group: '', short: 'ev', namespaced: true, kind: 'Event', version: 'v1' },
  { plural: 'namespaces', group: '', short: 'ns', namespaced: false, kind: 'Namespace', version: 'v1' },
  { plural: 'nodes', group: '', short: 'no', namespaced: false, kind: 'Node', version: 'v1' },
  { plural: 'pods', group: '', short: 'po', namespaced: true, kind: 'Pod', version: 'v1' },
  { plural: 'resourcequotas', group: '', short: 'quota', namespaced: true, kind: 'ResourceQuota', version: 'v1' },
  { plural: 'secrets', group: '', namespaced: true, kind: 'Secret', version: 'v1' },
  { plural: 'daemonsets', group: 'apps', short: 'ds', namespaced: true, kind: 'DaemonSet', version: 'v1' },
  { plural: 'deployments', group: 'apps', short: 'deploy', namespaced: true, kind: 'Deployment', version: 'v1' },
  { plural: 'replicasets', group: 'apps', short: 'rs', namespaced: true, kind: 'ReplicaSet', version: 'v1' },
  { plural: 'cronjobs', group: 'batch', short: 'cj', namespaced: true, kind: 'CronJob', version: 'v1' },
  { plural: 'jobs', group: 'batch', namespaced: true, kind: 'Job', version: 'v1' },
];

const KINDS: Record<string, string> = { all: 'all' };
for (const k of KIND_INFO) {
  for (const n of [k.plural, k.plural.slice(0, -1), k.kind.toLowerCase(), k.short]) if (n) KINDS[n] = k.plural;
  if (k.group) KINDS[`${k.plural}.${k.group}`] = k.plural;
}
KINDS.resourcequota = 'resourcequotas';
const info = (plural: string) => KIND_INFO.find((k) => k.plural === plural)!;
/** "deployment.apps", "pod": how kubectl names a kind in messages. */
const qualified = (plural: string) => { const i = info(plural); return i.group ? `${i.kind.toLowerCase()}.${i.group}` : i.kind.toLowerCase(); };
const resource = (plural: string) => { const i = info(plural); return i.group ? `${plural}.${i.group}` : plural; };
const notFound = (plural: string, name: string) => new Error(`Error from server (NotFound): ${resource(plural)} "${name}" not found`);

/** Kinds this sandbox knows about in real kubectl but does not model, so it can say so instead of "doesn't have a resource type". */
const ELSEWHERE: Record<string, string> = {
  svc: 'services', service: 'services', services: 'services', ing: 'ingresses', ingress: 'ingresses', ingresses: 'ingresses',
  pvc: 'persistentvolumeclaims', pv: 'persistentvolumes', sts: 'statefulsets', statefulset: 'statefulsets', statefulsets: 'statefulsets',
  netpol: 'networkpolicies', networkpolicy: 'networkpolicies', networkpolicies: 'networkpolicies', sa: 'serviceaccounts', serviceaccount: 'serviceaccounts', serviceaccounts: 'serviceaccounts',
  ep: 'endpoints', endpoints: 'endpoints', crd: 'customresourcedefinitions', crds: 'customresourcedefinitions', pdb: 'poddisruptionbudgets',
  role: 'roles', roles: 'roles', rolebinding: 'rolebindings', rolebindings: 'rolebindings', sc: 'storageclasses', storageclass: 'storageclasses', limitrange: 'limitranges', limits: 'limitranges',
};

function kindOf(word: string | undefined): string {
  if (!word) throw new Error('error: You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.');
  const k = KINDS[word.toLowerCase()];
  if (k) return k;
  if (ELSEWHERE[word.toLowerCase()]) throw new Error(`error: real kubectl has ${ELSEWHERE[word.toLowerCase()]}; this sandbox does not model them. Other lessons on this track teach them with their own simulators.`);
  throw new Error(`error: the server doesn't have a resource type "${word}"`);
}

// ---- flags -------------------------------------------------------------

type FlagSpec = Record<string, 'bool' | 'value' | 'multi'>;
type Parsed = { pos: string[]; f: Record<string, string | boolean | string[]>; after: string[] | null };

const ALIASES: Record<string, string> = { '-n': '--namespace', '-A': '--all-namespaces', '-l': '--selector', '-o': '--output', '-L': '--label-columns', '-c': '--container', '-p': '--patch', '-f': '--filename', '-w': '--watch' };

function parse(args: string[], verb: string, spec: FlagSpec, aliases: Record<string, string> = ALIASES): Parsed {
  const out: Parsed = { pos: [], f: {}, after: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { out.after = args.slice(i + 1); break; }
    if (!a.startsWith('-') || a === '-') { out.pos.push(a); continue; }
    let name = a, value: string | undefined;
    const eq = a.indexOf('=');
    if (eq > 0) { name = a.slice(0, eq); value = a.slice(eq + 1); }
    // -nshop is -n shop, as in real kubectl.
    if (!name.startsWith('--') && name.length > 2 && aliases[name.slice(0, 2)] && value === undefined) { value = name.slice(2); name = name.slice(0, 2); }
    const long = name.startsWith('--') ? name : aliases[name];
    if (!long || !spec[long]) {
      throw new Error(name.startsWith('--')
        ? `error: unknown flag: ${name}\nSee 'kubectl ${verb} --help' for usage.`
        : `error: unknown shorthand flag: '${name.slice(1, 2)}' in ${a}\nSee 'kubectl ${verb} --help' for usage.`);
    }
    if (spec[long] === 'bool') {
      out.f[long] = value === undefined ? true : value !== 'false';
      continue;
    }
    if (value === undefined) {
      if (i + 1 >= args.length) throw new Error(`error: flag needs an argument: '${name.replace(/^-+/, '')}' in ${name}`);
      value = args[++i];
    }
    if (spec[long] === 'multi') out.f[long] = [...((out.f[long] as string[]) ?? []), value];
    else out.f[long] = value;
  }
  return out;
}

const NS_FLAGS: FlagSpec = { '--namespace': 'value' };
const s = (p: Parsed, k: string) => p.f[k] as string | undefined;
const b = (p: Parsed, k: string) => p.f[k] === true;

function nsOf(c: Cluster, p: Parsed) { return s(p, '--namespace') ?? c.context.namespace; }

/** "deployment/hello", "deploy hello" and "hello" (when the kind is implied) all name the same thing. */
function target(pos: string[], impliedKind?: string): { kind: string; name: string; rest: string[] } {
  if (pos[0]?.includes('/')) { const [k, n] = pos[0].split('/'); return { kind: kindOf(k), name: n, rest: pos.slice(1) }; }
  if (impliedKind && pos.length && !KINDS[pos[0]?.toLowerCase()]) return { kind: impliedKind, name: pos[0], rest: pos.slice(1) };
  return { kind: kindOf(pos[0]), name: pos[1], rest: pos.slice(2) };
}

// ---- labels and selectors ---------------------------------------------

type Sel = { key: string; op: '=' | '!=' | 'exists' | '!exists' | 'in' | 'notin'; values: string[] };
export function parseSelector(sel: string): Sel[] {
  const out: Sel[] = [];
  // Split on commas that are not inside a set: "app in (a,b),tier=web".
  const parts = sel.match(/[^,(]+(\([^)]*\))?/g) ?? [];
  for (const raw of parts.map((x) => x.trim()).filter(Boolean)) {
    let m: RegExpExecArray | null;
    if ((m = /^([\w./-]+)\s+(in|notin)\s+\(([^)]*)\)$/.exec(raw))) out.push({ key: m[1], op: m[2] as 'in', values: m[3].split(',').map((v) => v.trim()) });
    else if ((m = /^([\w./-]+)\s*(!=|==|=)\s*([\w.-]*)$/.exec(raw))) out.push({ key: m[1], op: m[2] === '!=' ? '!=' : '=', values: [m[3]] });
    else if ((m = /^!([\w./-]+)$/.exec(raw))) out.push({ key: m[1], op: '!exists', values: [] });
    else if ((m = /^([\w./-]+)$/.exec(raw))) out.push({ key: m[1], op: 'exists', values: [] });
    else throw new Error(`error: unable to parse requirement: found '${raw}', expected: identifier`);
  }
  return out;
}
export function selects(sel: Sel[], labels: Record<string, string>) {
  return sel.every((r) => {
    const has = r.key in labels, v = labels[r.key];
    switch (r.op) {
      case '=': return has && v === r.values[0];
      case '!=': return !has || v !== r.values[0];
      case 'exists': return has;
      case '!exists': return !has;
      case 'in': return has && r.values.includes(v);
      case 'notin': return !has || !r.values.includes(v);
    }
  });
}
const labelText = (l: Record<string, string>) => Object.keys(l).length ? Object.keys(l).sort().map((k) => `${k}=${l[k]}`).join(',') : '<none>';

// ---- entry -------------------------------------------------------------

export function kubectl(c: Cluster, line: string, observe?: Observer, files: Files = {}): Out[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    // The one pipe this terminal understands: decoding a Secret value, which
    // is the whole point of showing that base64 is not encryption.
    const b64 = /^echo\s+(['"]?)([A-Za-z0-9+/=]+)\1\s*\|\s*base64\s+(-d|--decode)$/.exec(trimmed);
    if (b64) return lines(unbase64(b64[2]));
    if (trimmed.includes('|')) throw new Error('this terminal has no pipes (except echo <text> | base64 -d). Run each command on its own.');
    const argv = tokenize(trimmed);
    if (argv[0] === 'help') return lines(HELP);
    if (argv[0] === 'clear') return [];
    if (argv[0] === 'ls') return lines(Object.keys(files).sort().join('  ') || '');
    if (argv[0] === 'cat') {
      const f = argv[1];
      if (!f || !(f in files)) throw new Error(`cat: ${f ?? ''}: No such file or directory`);
      observe?.({ verb: 'cat', name: f });
      return lines(toYaml(files[f]));
    }
    if (argv[0] !== 'kubectl' && argv[0] !== 'k') throw new Error(`${argv[0]}: command not found (this terminal speaks kubectl - type help)`);
    return run(c, argv.slice(1), observe, files);
  } catch (e) {
    if (e instanceof Invalid) return lines(`The request is invalid: ${e.message}`, 'err');
    if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError || !(e instanceof Error)) {
      // An exception the sandbox did not throw on purpose is its own bug, not the learner's.
      return lines(`a bug in the sandbox, not in your command: ${(e as Error)?.message ?? e}. Start over to reset.`, 'err');
    }
    return lines((e as Error).message, 'err');
  }
}

function lines(text: string, kind: Out['kind'] = 'out'): Out[] {
  return text ? text.split('\n').map((t) => ({ text: t, kind })) : [];
}
const say = (text: string): Out[] => lines(text);
const warn = (ws: string[]): Out[] => ws.flatMap((w) => lines(w, 'dim'));

export const HELP = `kubectl get <kind> [name] [-n ns | -A] [-l key=value] [-o wide|yaml|json|name|jsonpath=...] [--show-labels] [-L key]
   kinds: pods deploy rs nodes events quota ns cm secrets jobs cronjobs ds all
kubectl describe <kind> <name>        kubectl logs <pod> [-c container] [--previous]
kubectl create deployment|job|cronjob|namespace|configmap|secret generic|quota ...
kubectl run <name> --image=<image> [--restart=Never] [--overrides='<json>']
kubectl apply -f <file>   (ls and cat show the files this mission gives you)
kubectl scale | set image|resources|env | patch | label | taint | rollout status|undo|restart | delete
kubectl exec <pod> [-c container] -- cat|ls|env|printenv|id
kubectl config current-context | get-contexts | set-context --current --namespace=<ns>
kubectl api-resources   kubectl explain <path>
Images: panda/hello:1.0 hello:2.0 hello-nonroot:1.0 greedy:1.0 slowpoke:1.0 needs-config:1.0 greeter:1.0 reads-file:1.0
        db:1.0 log-shipper:1.0 wait-for-db:1.0 migrate:1.0 report:1.0 slow-report:1.0 flaky-report:1.0`;

const NOT_HERE: Record<string, string> = {
  edit: 'it opens an editor. Use kubectl patch here, or kubectl apply -f with a file',
  'port-forward': 'there is no network to forward to',
  top: 'there is no metrics-server here; see the metrics-server lesson',
  cordon: 'node maintenance is taught with its own simulator', uncordon: 'node maintenance is taught with its own simulator', drain: 'node maintenance is taught with its own simulator',
  expose: 'Services are taught with their own simulator', attach: 'there is no process to attach to', cp: 'there are no files to copy', debug: 'there is no process to debug',
  auth: 'RBAC is taught in the cluster-access lesson', certificate: 'certificates are not modelled', replace: 'use kubectl apply -f here', wait: 'time runs on its own here: run get again',
  diff: 'use kubectl get -o yaml and compare', events: 'kubectl get events shows the same list here', 'api-versions': 'kubectl api-resources lists what it models',
  proxy: 'there is no network to proxy to', completion: 'there is no shell to complete in', plugin: 'there are no plugins', alpha: 'alpha commands are not modelled', kustomize: 'Kustomize has its own lesson', annotate: 'annotations are not modelled beyond rollout restart', autoscale: 'autoscaling has its own lesson',
};

function run(c: Cluster, argv: string[], observe: Observer | undefined, files: Files): Out[] {
  // Global flags may come before the verb (kubectl -n shop get pods). Move
  // them after the verb's own words, but before any `--`.
  const lead: string[] = [];
  let i = 0;
  while (i < argv.length && /^(-n|--namespace|-A|--all-namespaces)(=.*)?$/.test(argv[i])) {
    lead.push(argv[i]);
    if ((argv[i] === '-n' || argv[i] === '--namespace') && i + 1 < argv.length) lead.push(argv[++i]);
    i++;
  }
  const [verb, ...tail0] = argv.slice(i);
  const dd = tail0.indexOf('--');
  const rest = dd < 0 ? [...tail0, ...lead] : [...tail0.slice(0, dd), ...lead, ...tail0.slice(dd)];
  switch (verb) {
    case 'get': return get(c, rest, observe);
    case 'describe': return describe(c, rest, observe);
    case 'logs': return logs(c, rest, observe);
    case 'create': return create(c, rest, observe);
    case 'run': return runPod(c, rest);
    case 'scale': {
      const p = parse(rest, 'scale', { ...NS_FLAGS, '--replicas': 'value' });
      const t = target(p.pos);
      const n = s(p, '--replicas');
      if (n === undefined) throw new Error("error: required flag(s) \"replicas\" not set");
      if (t.kind !== 'deployments') throw new Error(`error: this sandbox scales deployments only (a DaemonSet has no replica count: it runs one pod per eligible node)`);
      c.deployment(t.name, nsOf(c, p)).replicas = Math.max(0, Number(n));
      return say(`deployment.apps/${t.name} scaled`);
    }
    case 'set': return set(c, rest);
    case 'patch': return patch(c, rest, observe);
    case 'label': return label(c, rest, observe);
    case 'taint': return taint(c, rest, observe);
    case 'rollout': return rollout(c, rest);
    case 'delete': return del(c, rest, observe);
    case 'apply': return apply(c, rest, files, observe);
    case 'exec': return exec(c, rest, observe);
    case 'config': return config(c, rest, observe);
    case 'api-resources': return apiResources(rest);
    case 'explain': return explain(rest);
    case 'version': return say('Client Version: v1.37.2\nKustomize Version: v5.8.1\nServer Version: v1.36.1 (the sandbox imitates this version)');
    case 'cluster-info': return say('Kubernetes control plane is running at https://127.0.0.1:6443 (simulated)');
    case undefined: return say(HELP);
    default:
      if (NOT_HERE[verb]) throw new Error(`kubectl ${verb}: real kubectl has this; this sandbox does not, because ${NOT_HERE[verb]}.`);
      throw new Error(`error: unknown command "${verb}" for "kubectl"\n\nDid you mean this?\n\t(type help for what this sandbox understands)`);
  }
}

// ---- get ---------------------------------------------------------------

const GET_FLAGS: FlagSpec = { ...NS_FLAGS, '--all-namespaces': 'bool', '--selector': 'value', '--output': 'value', '--show-labels': 'bool', '--label-columns': 'multi', '--field-selector': 'value', '--watch': 'bool' };

function get(c: Cluster, rest: string[], observe?: Observer): Out[] {
  const p = parse(rest, 'get', GET_FLAGS);
  if (b(p, '--watch')) throw new Error('error: this sandbox has no --watch: the cluster ticks on its own and the picture on the right updates. Run get again to see the latest.');
  const allNs = b(p, '--all-namespaces');
  const ns = nsOf(c, p);
  const out = s(p, '--output');
  if (out && !['wide', 'yaml', 'json', 'name'].includes(out) && !out.startsWith('jsonpath=') && !out.startsWith('custom-columns=')) {
    throw new Error(`error: unable to match a printer suitable for the output format "${out}", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,kyaml,name,template,templatefile,wide,yaml`);
  }
  const sel = s(p, '--selector') ? parseSelector(s(p, '--selector')!) : null;
  const field = s(p, '--field-selector');
  // kubectl get pods,deploy - several kinds at once.
  const kinds = (p.pos[0] ?? '').split(',').filter(Boolean);
  if (!kinds.length) throw new Error('error: You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.');
  let names = p.pos.slice(1);
  let kindList: string[];
  if (kinds.length === 1 && kinds[0].includes('/')) { kindList = [kindOf(kinds[0].split('/')[0])]; names = [kinds[0].split('/')[1], ...names]; }
  else kindList = kinds.flatMap((k) => kindOf(k) === 'all' ? ['pods', 'deployments', 'replicasets', 'daemonsets', 'jobs', 'cronjobs'] : [kindOf(k)]);
  const multi = kindList.length > 1;
  if (names.length && (allNs)) throw new Error('error: a resource cannot be retrieved by name across all namespaces');
  const showLabels = b(p, '--show-labels');
  const labelCols = ((p.f['--label-columns'] as string[]) ?? []).flatMap((x) => x.split(','));
  const objs: { kind: string; ns: string; name: string; obj: unknown; row: string[]; labels: Record<string, string> }[] = [];
  const heads = new Map<string, string[]>();
  const errors: string[] = [];
  for (const kind of kindList) {
    const r = listKind(c, kind, out === 'wide');
    heads.set(kind, r.head);
    // The API server lists in key order: namespace, then name. Events keep their own order.
    const scoped = r.items.filter((x) => !info(kind).namespaced || allNs || x.ns === ns)
      .sort((a, b2) => kind === 'events' || kind === 'nodes' ? 0 : a.ns.localeCompare(b2.ns) || a.name.localeCompare(b2.name));
    const picked = names.length ? names.map((n) => { const f = scoped.find((x) => x.name === n); if (!f) errors.push(notFound(kind, n).message); return f; }).filter(Boolean) as typeof scoped : scoped;
    for (const x of picked) {
      if (sel && !selects(sel, x.labels)) continue;
      if (field && !fieldMatch(field, kind, x, c)) continue;
      objs.push({ kind, ...x });
    }
  }
  observe?.({ verb: 'get', kind: kindList.join(','), name: names[0], ns, allNs, output: out, selector: s(p, '--selector'), text: objs.map((o) => `${o.ns}/${o.name}`).join(' ') });
  const body: string[] = [];
  if (out === 'yaml' || out === 'json') {
    const o = objs.length === 1 && names.length === 1 ? objs[0].obj : listOf(objs.map((x) => x.obj));
    body.push(out === 'yaml' ? toYaml(o) : JSON.stringify(o, null, 4));
  } else if (out === 'name') {
    body.push(...objs.map((o) => `${qualified(o.kind)}/${o.name}`));
  } else if (out?.startsWith('jsonpath=')) {
    const o = objs.length === 1 && names.length === 1 ? objs[0].obj : listOf(objs.map((x) => x.obj));
    body.push(jsonpath(o, out.slice('jsonpath='.length)));
  } else if (out?.startsWith('custom-columns=')) {
    const cols = out.slice('custom-columns='.length).split(',').map((x) => { const i = x.indexOf(':'); return { h: x.slice(0, i), path: x.slice(i + 1) }; });
    body.push(table([cols.map((x) => x.h), ...objs.map((o) => cols.map((x) => customCell(o.obj, x.path)))]));
  } else {
    for (const kind of kindList) {
      const mine = objs.filter((o) => o.kind === kind);
      if (!mine.length) continue;
      const head = [...(allNs && info(kind).namespaced ? ['NAMESPACE'] : []), ...heads.get(kind)!, ...labelCols.map((l) => l.split('/').pop()!.toUpperCase()), ...(showLabels ? ['LABELS'] : [])];
      const rows = mine.map((o) => [
        ...(allNs && info(kind).namespaced ? [o.ns] : []),
        ...(multi ? [`${qualified(kind)}/${o.row[0]}`, ...o.row.slice(1)] : o.row),
        ...labelCols.map((l) => o.labels[l] ?? ''),
        ...(showLabels ? [labelText(o.labels)] : []),
      ]);
      body.push(table([head, ...rows]));
    }
  }
  const text = body.filter((x) => x !== '').join(out ? '\n' : '\n\n');
  const res: Out[] = [...errors.flatMap((e) => lines(e, 'err'))];
  if (!objs.length && !errors.length && !out?.match(/yaml|json/)) {
    if (kindList[0] === 'events' && !sel && !field) return [...res, ...lines(allNs ? 'No events found.' : `No events found in ${ns} namespace.`, 'dim')];
    // Real kubectl prints this to stderr, with exit code 0: it is not an error.
    return [...res, ...lines(allNs || !kindList.some((k) => info(k).namespaced) ? 'No resources found' : `No resources found in ${ns} namespace.`, 'dim')];
  }
  return [...res, ...lines(text)];
}

function fieldMatch(field: string, kind: string, x: { obj: unknown; name: string }, c: Cluster) {
  return field.split(',').every((clause) => {
    const m = /^([\w.]+)(!=|==|=)(.*)$/.exec(clause);
    if (!m) throw new Error(`error: invalid field selector "${clause}"`);
    const [, path, op, want] = m;
    let have: string | undefined;
    if (kind === 'events' && path === 'reason') have = (x.obj as { reason: string }).reason;
    else if (kind === 'events' && path === 'type') have = (x.obj as { type: string }).type;
    else if (kind === 'events' && path === 'involvedObject.name') have = (x.obj as { involvedObject: { name: string } }).involvedObject.name;
    else if (kind === 'pods' && path === 'status.phase') have = (x.obj as { status: { phase: string } }).status.phase;
    else if (kind === 'pods' && path === 'spec.nodeName') have = (x.obj as { spec: { nodeName?: string } }).spec.nodeName ?? '';
    else if (path === 'metadata.name') have = x.name;
    else throw new Error(`error: this sandbox supports --field-selector on metadata.name, events' reason, type and involvedObject.name, and pods' status.phase and spec.nodeName ("${path}" is real, just not modelled)`);
    void c;
    return op === '!=' ? have !== want : have === want;
  });
}

type Item = { ns: string; name: string; obj: unknown; row: string[]; labels: Record<string, string> };

function podRow(c: Cluster, p: Pod, wide: boolean) {
  const restarts = c.totalRestarts(p);
  const lastAt = Math.max(p.last && p.restarts ? p.last.at : -1, ...p.inits.map((x) => (x.last && x.restarts ? x.last.at : -1)));
  return [p.name, c.podReady(p), c.podStatus(p), restarts && lastAt >= 0 ? `${restarts} (${age(c, lastAt)} ago)` : String(restarts), age(c, p.created),
    ...(wide ? [p.ip && p.status !== 'Pending' ? p.ip : '<none>', p.node ?? '<none>', '<none>', '<none>'] : [])];
}

function listKind(c: Cluster, kind: string, wide: boolean): { head: string[]; items: Item[] } {
  switch (kind) {
    case 'pods':
      return {
        head: ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : [])],
        items: [...c.pods.values()].map((p) => ({ ns: p.ns, name: p.name, obj: podObj(c, p), row: podRow(c, p, wide), labels: p.labels })),
      };
    case 'deployments':
      return {
        head: ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])],
        items: [...c.deployments.values()].map((d) => {
          const st = c.deploymentStatus(d.name, d.ns);
          return { ns: d.ns, name: d.name, obj: deploymentObj(c, d), labels: d.labels, row: [d.name, `${st.ready}/${st.desired}`, String(st.upToDate), String(st.available), age(c, d.created), ...(wide ? [ctrNames(d.template), images(d.template), `app=${d.labels.app ?? d.name}`] : [])] };
        }),
      };
    case 'replicasets':
      return {
        head: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])],
        items: [...c.replicasets.values()].map((r) => {
          const live = c.live(r.name, r.ns);
          return { ns: r.ns, name: r.name, obj: replicaSetObj(c, r), labels: { ...r.template.labels, 'pod-template-hash': r.hash }, row: [r.name, String(r.replicas), String(live.length), String(live.filter((x) => x.ready).length), age(c, r.created), ...(wide ? [ctrNames(r.template), images(r.template), `${labelText(r.template.labels)},pod-template-hash=${r.hash}`] : [])] };
        }),
      };
    case 'nodes':
      // Real kubectl's columns, nothing more. This once added CPU and MEMORY
      // columns of its own, and a mission sent learners to `get nodes` to see
      // how full the nodes were, which no real cluster would show them. The
      // numbers are under "Allocated resources" in kubectl describe node.
      return {
        head: ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION', ...(wide ? ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'] : [])],
        items: c.nodes.map((n, i) => ({ ns: '', name: n.name, obj: nodeObj(c, n), labels: n.labels, row: [n.name, 'Ready', roles(n), age(c, n.created - 1000), 'v1.36.1', ...(wide ? [`172.18.0.${i + 2}`, '<none>', 'Debian GNU/Linux 13 (trixie)', '(simulated)', 'containerd://2.3.1'] : [])] })),
      };
    case 'namespaces':
      return { head: ['NAME', 'STATUS', 'AGE'], items: [...c.namespaces.values()].sort((a, b2) => a.name.localeCompare(b2.name)).map((n) => ({ ns: '', name: n.name, obj: namespaceObj(c, n), labels: n.labels, row: [n.name, n.terminating ? 'Terminating' : 'Active', age(c, n.created - (n.name.startsWith('kube') || n.name === 'default' ? 1000 : 0))] })) };
    case 'events':
      return {
        head: ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'],
        items: c.events.slice(-60).map((e, i) => ({ ns: e.ns, name: `${e.object.split('/')[1]}.${i}`, labels: {}, obj: { reason: e.reason, type: e.type, involvedObject: { name: e.object.split('/')[1] }, message: e.message }, row: [age(c, e.tick), e.type, e.reason, e.object, e.message] })),
      };
    case 'resourcequotas':
      return { head: ['NAME', 'REQUEST', 'LIMIT', 'AGE'], items: [...c.quotas.values()].map((q) => ({ ns: q.ns, name: q.name, obj: quotaObj(c, q), labels: {}, row: [q.name, `pods: ${c.podsIn(q.ns).filter((x) => x.status !== 'Terminating' && c.holds(x)).length}/${q.pods}`, '', age(c, q.created)] })) };
    case 'configmaps':
      return { head: ['NAME', 'DATA', 'AGE'], items: [...c.configmaps.values()].map((m) => ({ ns: m.ns, name: m.name, obj: configMapObj(c, m), labels: m.labels, row: [m.name, String(Object.keys(m.data).length), age(c, m.created)] })) };
    case 'secrets':
      return { head: ['NAME', 'TYPE', 'DATA', 'AGE'], items: [...c.secrets.values()].map((x) => ({ ns: x.ns, name: x.name, obj: secretObj(c, x), labels: x.labels, row: [x.name, x.type, String(Object.keys(x.data).length), age(c, x.created)] })) };
    case 'jobs':
      return {
        head: ['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])],
        items: [...c.jobs.values()].map((j) => {
          const st = c.jobStatus(j);
          const status = j.condition ?? (j.suspend ? 'Suspended' : 'Running');
          const dur = (j.condition === 'Complete' ? j.finishedAt! : c.tick) - j.created;
          return { ns: j.ns, name: j.name, obj: jobObj(c, j), labels: { 'batch.kubernetes.io/job-name': j.name, 'job-name': j.name }, row: [j.name, status, `${st.succeeded}/${j.completions}`, human(dur * SECONDS_PER_TICK), age(c, j.created), ...(wide ? [ctrNames(j.template), images(j.template), `batch.kubernetes.io/controller-uid=${j.uid}`] : [])] };
        }),
      };
    case 'cronjobs':
      return {
        head: ['NAME', 'SCHEDULE', 'TIMEZONE', 'SUSPEND', 'ACTIVE', 'LAST SCHEDULE', 'AGE'],
        items: [...c.cronjobs.values()].map((cj) => {
          const active = [...c.jobs.values()].filter((j) => j.ns === cj.ns && j.owner === cj.name && !j.manual && !j.condition).length;
          return { ns: cj.ns, name: cj.name, obj: cronJobObj(c, cj), labels: {}, row: [cj.name, cj.schedule, '<none>', cj.suspend ? 'True' : 'False', String(active), cj.lastSchedule === undefined ? '<none>' : age(c, cj.lastSchedule), age(c, cj.created)] };
        }),
      };
    case 'daemonsets':
      return {
        head: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])],
        items: [...c.daemonsets.values()].map((ds) => {
          const st = c.dsStatus(ds);
          return { ns: ds.ns, name: ds.name, obj: daemonSetObj(c, ds), labels: ds.labels, row: [ds.name, String(st.desired), String(st.current), String(st.ready), String(st.upToDate), String(st.available), labelText(ds.template.nodeSelector), age(c, ds.created), ...(wide ? [ctrNames(ds.template), images(ds.template), labelText(ds.template.labels)] : [])] };
        }),
      };
  }
  throw new Error(`error: the server doesn't have a resource type "${kind}"`);
}

const ctrNames = (t: Template) => [t.name, ...t.sidecars.map((x) => x.name)].join(',');
const images = (t: Template) => [t.image, ...t.sidecars.map((x) => x.image)].join(',');
const roles = (n: Node) => Object.keys(n.labels).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1]).join(',') || '<none>';

// A small JSONPath: {.a.b}, {.a[0]}, {.a[*].b}, {..b}, several {} in a row and
// literal text between them. Ranges and filters are real kubectl features this
// sandbox refuses by name.
export function jsonpath(obj: unknown, expr: string): string {
  if (/\{range|\?\(/.test(expr)) throw new Error('error: this sandbox\'s jsonpath supports {.a.b}, {.a[0]}, {.a[*]} and {..a}, not range or filters');
  return expr.replace(/\{([^}]*)\}/g, (_, path: string) => {
    let cur: unknown[] = [obj];
    const toks = path.trim().match(/\.\.[\w.-]+|\.[\w\-/]+|\.'[^']+'|\[[^\]]+\]/g) ?? [];
    if (path.trim() && toks.join('') !== path.trim().replace(/^\$/, '')) throw new Error(`error: error parsing jsonpath {${path}}, unrecognized character`);
    for (const t of toks) {
      if (t.startsWith('..')) { const k = t.slice(2); const found: unknown[] = []; const walk = (v: unknown) => { if (v && typeof v === 'object') { for (const [kk, vv] of Object.entries(v)) { if (kk === k) found.push(vv); walk(vv); } } }; cur.forEach(walk); cur = found; continue; }
      if (t.startsWith('.')) { const k = t.slice(1).replace(/^'|'$/g, ''); cur = cur.flatMap((v) => (v && typeof v === 'object' && k in v ? [(v as Record<string, unknown>)[k]] : [])); continue; }
      const inner = t.slice(1, -1);
      if (inner === '*') { cur = cur.flatMap((v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [])); continue; }
      if (/^\d+$/.test(inner)) { cur = cur.flatMap((v) => (Array.isArray(v) && Number(inner) < v.length ? [v[Number(inner)]] : [])); continue; }
      const q = /^'(.*)'$/.exec(inner);
      if (q) { cur = cur.flatMap((v) => (v && typeof v === 'object' && q[1] in v ? [(v as Record<string, unknown>)[q[1]]] : [])); continue; }
      throw new Error(`error: this sandbox's jsonpath does not understand [${inner}]`);
    }
    return cur.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' ');
  });
}

function customCell(obj: unknown, path: string) {
  const v = jsonpath(obj, `{${path}}`);
  if (v === '') return '<none>';
  // kubectl prints a list of maps the Go way: [map[effect:NoSchedule key:...]].
  try {
    const parsed = JSON.parse(v);
    const go = (x: unknown): string => Array.isArray(x) ? `[${x.map(go).join(' ')}]` : x && typeof x === 'object' ? `map[${Object.keys(x).sort().map((k) => `${k}:${go((x as Record<string, unknown>)[k])}`).join(' ')}]` : String(x);
    if (typeof parsed === 'object') return go(parsed);
  } catch { /* a plain value */ }
  return v;
}

// ---- describe ----------------------------------------------------------

function eventsBlock(c: Cluster, evs: KEvent[]) {
  if (!evs.length) return 'Events:  <none>';
  const rows = evs.slice(-12).map((e) => ['  ' + e.type, e.reason, e.count > 1 ? `${age(c, e.tick)} (x${e.count} over ${age(c, e.first)})` : age(c, e.tick), e.from, e.field ? `${e.field}: ${e.message}` : e.message]);
  // describe pads its Events with two spaces (tabwriter), not get's three:
  // "  Type    Reason             Age   From" on kind v1.36.1.
  return `Events:\n${tabw([['  Type', 'Reason', 'Age', 'From', 'Message'], ['  ----', '------', '----', '----', '-------'], ...rows].map((r) => r.join('\t')).join('\n'))}`;
}

const labelLines = (l: Record<string, string>, w = 18) => {
  const ks = Object.keys(l).sort();
  if (!ks.length) return '<none>';
  return ks.map((k, i) => (i ? ' '.repeat(w) : '') + `${k}=${l[k]}`).join('\n');
};

type CtrX = { env: Record<string, string>; envRefs: Template['envRefs']; envFrom: Template['envFrom']; mounts: Template['mounts'] };

/**
 * One container's lines as describe writes them, with tabs where kubectl's
 * tabwriter puts them (tabw lines them up). Shared by describe pod, where
 * `status` carries State, Ready and Restart Count, and by every Pod Template
 * block, which has none. Shapes from kubectl 1.37.2 against kind v1.36.1: a
 * podinfo pod on the tilt platform, and a Deployment with resources, a probe,
 * env from a ConfigMap and a Secret, and three volumes.
 */
function ctrLines(t: Template, name: string, image: string, x: CtrX, main: boolean, status: string[] = []) {
  const out = [`${'  '}${name}:`, `    Image:\t${image}`, '    Port:\t<none>', '    Host Port:\t<none>', ...status];
  if (main) {
    out.push('    Limits:', `      memory:\t${fmtMem(t.limits.mem)}`, '    Requests:', `      cpu:\t${fmtCpu(t.requests.cpu)}`, `      memory:\t${fmtMem(t.requests.mem)}`);
    // Real describe leaves out a probe that is not set, rather than printing <none>.
    if (t.liveness) out.push(`    Liveness:\t${probeText(LIVENESS)}`);
    if (t.startupProbe) out.push(`    Startup:\t${probeText(t.startupProbe)}`);
  }
  if (x.envFrom.length) out.push('    Environment Variables from:', ...x.envFrom.map((e) => `      ${e.name}\t${e.kind === 'configMap' ? 'ConfigMap' : 'Secret'}\tOptional: false`));
  const vars = [
    ...x.envRefs.map((r) => `      ${r.name}:\t${r.kind === 'configMap' ? `<set to the key '${r.key}' of config map '${r.ref}'>` : `<set to the key '${r.key}' in secret '${r.ref}'>`}\tOptional: false`),
    ...Object.entries(x.env).map(([k, v]) => `      ${k}:\t${v}`),
  ];
  out.push(...(vars.length ? ['    Environment:', ...vars] : ['    Environment:\t<none>']));
  // kubectl lists mounts sorted by path, whatever order the spec gives them in.
  const mounts = [...x.mounts].sort((a, b) => a.mountPath.localeCompare(b.mountPath));
  out.push(...(mounts.length ? ['    Mounts:', ...mounts.map((m) => `      ${m.mountPath} from ${m.name} (rw${m.subPath ? `,path="${m.subPath}"` : ''})`)] : ['    Mounts:\t<none>']));
  return out;
}

function ctrBlock(c: Cluster, p: Pod, name: string, image: string, st: { status: string; ready: boolean; restarts: number; startedAt?: number; last?: Pod['last'] }, x: CtrX, main: boolean) {
  const t = p.template;
  let state: string[];
  if (st.status === 'Running') state = ['    State:\tRunning', `      Started:\t${stamp(c, st.startedAt ?? 0)}`];
  else if (st.status === 'Terminated' && st.last) state = ['    State:\tTerminated', `      Reason:\t${st.last.reason}`, `      Exit Code:\t${st.last.exitCode}`];
  else state = ['    State:\tWaiting', `      Reason:\t${main ? c.mainWaitReason(p) : p.status === 'CreateContainerConfigError' || p.status === 'ErrImagePull' || p.status === 'ImagePullBackOff' ? p.status : st.last ? 'CrashLoopBackOff' : 'PodInitializing'}`];
  const last = st.last && st.status !== 'Terminated' ? ['    Last State:\tTerminated', `      Reason:\t${st.last.reason}`, `      Exit Code:\t${st.last.exitCode}`] : [];
  // A pod with no node has no container status, so describe prints no State,
  // Ready or Restart Count for it (kind v1.36.1, a pod Pending on a nodeSelector).
  const status = p.node ? [...state, ...last, `    Ready:\t${st.ready ? 'True' : 'False'}`, `    Restart Count:\t${st.restarts}`] : [];
  return tabw(ctrLines(t, name, image, x, main, status).join('\n'));
}

// kubectl 1.37 prints successThreshold= and failureThreshold= here, not the
// older #success= and #failure=.
const probeText = (pr: { initialDelaySeconds: number; periodSeconds: number; failureThreshold: number }) =>
  `http-get http://:8080/ delay=${pr.initialDelaySeconds}s timeout=1s period=${pr.periodSeconds}s successThreshold=1 failureThreshold=${pr.failureThreshold}`;

function tolerationLines(t: Template, extra: boolean, w = 29) {
  const all = [...t.tolerations.map((x) => `${x.key ?? ''}${x.operator === 'Exists' ? '' : `=${x.value ?? ''}`}${x.effect ? `:${x.effect}` : ''}${x.operator === 'Exists' ? ' op=Exists' : ''}`),
    ...(extra ? ['node.kubernetes.io/not-ready:NoExecute op=Exists for 300s', 'node.kubernetes.io/unreachable:NoExecute op=Exists for 300s'] : [])];
  return all.length ? all.map((x, i) => (i ? ' '.repeat(w) : '') + x).join('\n') : '<none>';
}

function describePod(c: Cluster, p: Pod) {
  const t = p.template;
  const ctrl = p.ownerKind ? `\nControlled By:    ${p.ownerKind}/${p.owner}` : '';
  const inits = t.initContainers.length ? `\nInit Containers:\n${t.initContainers.map((ic, i) => ctrBlock(c, p, ic.name, ic.image, p.inits[i], ic, false)).join('\n')}` : '';
  const sides = t.sidecars.map((sc, i) => '\n' + ctrBlock(c, p, sc.name, sc.image, p.sides[i], sc, false)).join('');
  const mainSt = { status: p.status === 'Running' && !p.mainFinished ? 'Running' : (p.mainFinished || p.status === 'Succeeded' || p.status === 'Failed') ? 'Terminated' : 'Waiting', ready: p.ready, restarts: p.restarts, startedAt: p.startedAt, last: p.last };
  const vols = t.volumes.length ? t.volumes.map((v) => `\n  ${v.name}:\n    Type:       ${v.configMap ? 'ConfigMap (a volume populated by a ConfigMap)' : v.secret ? 'Secret (a volume populated by a Secret)' : 'EmptyDir (a temporary directory that shares a pod\'s lifetime)'}${v.configMap ? `\n    Name:       ${v.configMap}` : v.secret ? `\n    SecretName: ${v.secret}` : ''}`).join('') : ' <none>';
  const spread = t.spread.length ? `\nTopology Spread Constraints:  ${t.spread.map((sp) => `${sp.topologyKey}:${sp.whenUnsatisfiable} when max skew ${sp.maxSkew} is exceeded for selector ${labelText(sp.matchLabels)}`).join('\n                              ')}` : '';
  return `Name:             ${p.name}
Namespace:        ${p.ns}
Node:             ${p.node ?? '<none>'}
Labels:           ${labelLines(p.labels)}
Status:           ${c.podPhase(p)}
IP:               ${p.ip && p.status !== 'Pending' ? p.ip : ''}${ctrl}${inits}
Containers:
${ctrBlock(c, p, t.name, t.image, mainSt, t, true)}${sides}
Volumes:${vols}
Node-Selectors:              ${labelText(t.nodeSelector)}
Tolerations:                 ${tolerationLines(t, true)}${spread}
${eventsBlock(c, c.events.filter((e) => e.ns === p.ns && e.object === `pod/${p.name}`))}`;
}

const DESCRIBE_FLAGS: FlagSpec = { ...NS_FLAGS, '--all-namespaces': 'bool', '--selector': 'value' };

function describe(c: Cluster, rest: string[], observe?: Observer): Out[] {
  const p = parse(rest, 'describe', DESCRIBE_FLAGS);
  if (!p.pos.length) throw new Error('error: You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.');
  const t = target(p.pos);
  const ns = nsOf(c, p);
  const names = t.name ? [t.name, ...t.rest] : [];
  const sel = s(p, '--selector') ? parseSelector(s(p, '--selector')!) : null;
  const pick = <T extends { ns: string; name: string }>(all: Iterable<T>, labels: (x: T) => Record<string, string> = () => ({})) => {
    const scoped = [...all].filter((x) => b(p, '--all-namespaces') || x.ns === ns);
    if (names.length) return names.map((n) => { const f = scoped.find((x) => x.name === n); if (!f) throw notFound(t.kind, n); return f; });
    const got = scoped.filter((x) => !sel || selects(sel, labels(x)));
    if (!got.length) throw new Error(`No resources found in ${ns} namespace.`);
    return got;
  };
  const parts: string[] = [];
  switch (t.kind) {
    case 'pods':
      for (const x of pick(c.pods.values(), (y) => y.labels)) { observe?.({ verb: 'describe', kind: 'pods', name: x.name, ns: x.ns, pod: x }); parts.push(describePod(c, x)); }
      break;
    case 'deployments':
      for (const d of pick(c.deployments.values(), (y) => y.labels)) { observe?.({ verb: 'describe', kind: 'deployments', name: d.name, ns: d.ns }); parts.push(describeDeploy(c, d)); }
      break;
    case 'nodes': {
      const list = names.length ? names.map((n) => { const f = c.nodes.find((x) => x.name === n); if (!f) throw notFound('nodes', n); return f; }) : c.nodes.filter((n) => !sel || selects(sel, n.labels));
      for (const n of list) { observe?.({ verb: 'describe', kind: 'nodes', name: n.name }); parts.push(describeNode(c, n)); }
      break;
    }
    case 'resourcequotas':
      for (const q of pick(c.quotas.values())) {
        const used = c.podsIn(q.ns).filter((x) => x.status !== 'Terminating' && c.holds(x)).length;
        parts.push(`Name:       ${q.name}\nNamespace:  ${q.ns}\nResource    Used  Hard\n--------    ----  ----\npods        ${String(used).padEnd(6)}${q.pods}`);
      }
      break;
    case 'configmaps':
      for (const m of pick(c.configmaps.values(), (y) => y.labels)) {
        observe?.({ verb: 'describe', kind: 'configmaps', name: m.name, ns: m.ns });
        parts.push(`Name:         ${m.name}\nNamespace:    ${m.ns}\nLabels:       ${labelLines(m.labels, 14)}\nAnnotations:  <none>\n\nData\n====\n${Object.keys(m.data).sort().map((k) => `${k}:\n----\n${m.data[k]}\n`).join('\n')}\n\nBinaryData\n====\n\nEvents:  <none>`);
      }
      break;
    case 'secrets':
      for (const x of pick(c.secrets.values(), (y) => y.labels)) {
        observe?.({ verb: 'describe', kind: 'secrets', name: x.name, ns: x.ns });
        // describe shows sizes, never values. -o yaml shows the values, base64 encoded.
        parts.push(`Name:         ${x.name}\nNamespace:    ${x.ns}\nLabels:       ${labelLines(x.labels, 14)}\nAnnotations:  <none>\n\nType:  ${x.type}\n\nData\n====\n${Object.keys(x.data).sort().map((k) => `${k}:  ${new TextEncoder().encode(x.data[k]).length} bytes`).join('\n')}`);
      }
      break;
    case 'namespaces': {
      const list = names.length ? names.map((n) => c.namespace(n)) : [...c.namespaces.values()];
      for (const n of list) {
        const q = c.quotaIn(n.name);
        parts.push(`Name:         ${n.name}\nLabels:       ${labelLines(n.labels, 14)}\nAnnotations:  <none>\nStatus:       ${n.terminating ? 'Terminating' : 'Active'}\n\n${q ? `Resource Quotas\n  Name:     ${q.name}\n  Resource  Used  Hard\n  --------  ---   ---\n  pods      ${c.podsIn(n.name).filter((x) => x.status !== 'Terminating' && c.holds(x)).length}     ${q.pods}\n\n` : 'No resource quota.\n\n'}No LimitRange resource.`);
      }
      break;
    }
    case 'jobs':
      for (const j of pick(c.jobs.values())) { observe?.({ verb: 'describe', kind: 'jobs', name: j.name, ns: j.ns }); parts.push(describeJob(c, j)); }
      break;
    case 'cronjobs':
      for (const cj of pick(c.cronjobs.values())) { observe?.({ verb: 'describe', kind: 'cronjobs', name: cj.name, ns: cj.ns }); parts.push(describeCron(c, cj)); }
      break;
    case 'daemonsets':
      for (const ds of pick(c.daemonsets.values(), (y) => y.labels)) { observe?.({ verb: 'describe', kind: 'daemonsets', name: ds.name, ns: ds.ns }); parts.push(describeDs(c, ds)); }
      break;
    case 'replicasets':
      for (const r of pick(c.replicasets.values())) {
        const live = c.live(r.name, r.ns);
        const fail = r.failures > 0 && live.length < r.replicas;
        // Labels and the controller's annotations as kind v1.36.1 showed them for a Deployment's ReplicaSet.
        const owner = c.getDeployment(r.ns, r.owner);
        const ann = owner ? [`deployment.kubernetes.io/desired-replicas: ${owner.replicas}`, `deployment.kubernetes.io/max-replicas: ${owner.replicas + c.fenceposts(owner.replicas).surge}`, `deployment.kubernetes.io/revision: ${r.revision}`] : [`deployment.kubernetes.io/revision: ${r.revision}`];
        parts.push(`Name:           ${r.name}\nNamespace:      ${r.ns}\nSelector:       ${labelText({ ...r.template.labels, 'pod-template-hash': r.hash })}\nLabels:         ${labelLines({ ...r.template.labels, 'pod-template-hash': r.hash }, 16)}\nAnnotations:    ${ann.join('\n' + ' '.repeat(16))}\nControlled By:  Deployment/${r.owner}\nReplicas:       ${live.length} current / ${r.replicas} desired\nPods Status:    ${live.filter((x) => x.status === 'Running').length} Running / ${live.filter((x) => x.status !== 'Running').length} Waiting / 0 Succeeded / 0 Failed\nPod Template:\n${podTemplate({ ...r.template, labels: { ...r.template.labels, 'pod-template-hash': r.hash } })}${fail ? '\nConditions:\n  Type             Status  Reason\n  ----             ------  ------\n  ReplicaFailure   True    FailedCreate' : ''}\n${eventsBlock(c, c.events.filter((e) => e.ns === r.ns && e.object === `replicaset/${r.name}`))}`);
      }
      break;
    default:
      throw new Error(`error: this sandbox describes pods, deployments, replicasets, nodes, namespaces, configmaps, secrets, jobs, cronjobs, daemonsets and quotas`);
  }
  return say(parts.join('\n\n\n'));
}

/**
 * The Pod Template block of describe deployment, replicaset, job, cronjob and
 * daemonset, in the shape kubectl 1.37.2 printed for kind v1.36.1: Port and
 * Host Port lines, resources and probes when set, then Environment, Mounts,
 * Volumes, Node-Selectors and Tolerations, aligned by tabwriter's rules.
 */
function podTemplate(t: Template) {
  const ctr = (name: string, image: string, x: CtrX, main: boolean) => ctrLines(t, ` ${name}`, image, x, main);
  const labels = Object.keys(t.labels).sort().map((k, i) => `${i ? '' : '  Labels:'}\t${k}=${t.labels[k]}`);
  const vols = t.volumes.length ? ['  Volumes:', ...t.volumes.flatMap((v) => [`   ${v.name}:`,
    `    Type:\t${v.configMap ? 'ConfigMap (a volume populated by a ConfigMap)' : v.secret ? 'Secret (a volume populated by a Secret)' : 'EmptyDir (a temporary directory that shares a pod\'s lifetime)'}`,
    ...(v.configMap ? [`    Name:\t${v.configMap}`, '    Optional:\tfalse'] : v.secret ? [`    SecretName:\t${v.secret}`, '    Optional:\tfalse'] : ['    Medium:\t', '    SizeLimit:\t<unset>'])])] : ['  Volumes:\t<none>'];
  const tols = tolerationLines(t, false, 0).split('\n').map((x, i) => `${i ? '' : '  Tolerations:'}\t${x.trim()}`);
  return tabw([
    ...(labels.length ? labels : ['  Labels:\t<none>']),
    ...(t.initContainers.length ? ['  Init Containers:', ...t.initContainers.flatMap((x) => ctr(x.name, x.image, x, false))] : []),
    '  Containers:',
    ...[ctr(t.name, t.image, t, true), ...t.sidecars.map((x) => ctr(x.name, x.image, x, false))].flat(),
    ...vols,
    `  Node-Selectors:\t${labelText(t.nodeSelector)}`,
    ...tols,
  ].join('\n'));
}

/**
 * describe deployment as kubectl 1.37.2 printed it for kind v1.36.1. Its
 * Events are the Deployment's own, ScalingReplicaSet and nothing else: the
 * ReplicaSet's FailedCreate refusals are on the ReplicaSet. This once mixed
 * them in, so a learner looked for the refusal where no real cluster shows it.
 */
function describeDeploy(c: Cluster, d: Deployment) {
  const st = c.deploymentStatus(d.name, d.ns);
  const sets = [...c.replicasets.values()].filter((r) => r.ns === d.ns && r.owner === d.name);
  const cur = sets.find((r) => r.hash === templateHash(d.template));
  const rsText = (r: typeof sets[number]) => `${r.name} (${c.live(r.name, r.ns).length}/${r.replicas} replicas created)`;
  const old = sets.filter((r) => r !== cur && r.replicas > 0).sort((a, b) => a.created - b.created);
  const ev = c.events.filter((e) => e.ns === d.ns && e.object === `deployment/${d.name}`);
  // Conditions and the ReplicaSet lines share one tabwriter block; a condition
  // row ends in a space before its tab, which is why ReplicaFailure widens it.
  const block = tabw([
    '  Type\tStatus\tReason', '  ----\t------\t------',
    ...d.conditions.map((x) => `  ${x.type} \t${x.status}\t${x.reason}`),
    `OldReplicaSets:\t${old.length ? old.map(rsText).join(', ') : '<none>'}`,
    `NewReplicaSet:\t${cur ? rsText(cur) : '<none>'}`,
  ].join('\n'));
  return `Name:                   ${d.name}
Namespace:              ${d.ns}
CreationTimestamp:      ${stamp(c, d.created)}
Labels:                 ${labelLines(d.labels, 24)}
Annotations:            deployment.kubernetes.io/revision: ${d.revision}
Selector:               app=${d.labels.app ?? d.name}
Replicas:               ${st.desired} desired | ${st.upToDate} updated | ${st.current} total | ${st.available} available | ${st.unavailable} unavailable
StrategyType:           RollingUpdate
MinReadySeconds:        0
RollingUpdateStrategy:  25% max unavailable, 25% max surge
Pod Template:
${podTemplate(d.template)}
Conditions:
${block}
${eventsBlock(c, ev)}`;
}

function describeNode(c: Cluster, n: Node) {
  const u = c.used(n.name);
  const pods = [...c.pods.values()].filter((p) => p.node === n.name && c.holds(p) && p.status !== 'Terminating');
  // Columns, percentages (truncated, as kubectl does) and the resource rows
  // copied from describe node on kind v1.36.1. The sandbox's pods set no CPU
  // limit and no ephemeral storage, so those read 0 (0%), as they would.
  const pct = (v: number, of: number) => `${Math.floor((v / of) * 100)}%`;
  const memLim = (p: Pod) => p.template.limits.mem;
  const podTable = tabw([
    '  Namespace\tName\tCPU Requests\tCPU Limits\tMemory Requests\tMemory Limits\tAge',
    '  ---------\t----\t------------\t----------\t---------------\t-------------\t---',
    ...pods.map((p) => `  ${p.ns}\t${p.name}\t${p.template.requests.cpu}m (${pct(p.template.requests.cpu, n.cpu)})\t0 (0%)\t${fmtMem(p.template.requests.mem)} (${pct(p.template.requests.mem, n.mem)})\t${fmtMem(memLim(p))} (${pct(memLim(p), n.mem)})\t${age(c, p.created)}`),
  ].join('\n'));
  const limMem = pods.reduce((m, p) => m + memLim(p), 0);
  const alloc = tabw([
    '  Resource\tRequests\tLimits', '  --------\t--------\t------',
    `  cpu\t${u.cpu}m (${pct(u.cpu, n.cpu)})\t0 (0%)`,
    `  memory\t${fmtMem(u.mem)} (${pct(u.mem, n.mem)})\t${fmtMem(limMem)} (${pct(limMem, n.mem)})`,
    '  ephemeral-storage\t0 (0%)\t0 (0%)', '  hugepages-1Gi\t0 (0%)\t0 (0%)', '  hugepages-2Mi\t0 (0%)\t0 (0%)',
  ].join('\n'));
  return `Name:               ${n.name}
Roles:              ${roles(n)}
Labels:             ${labelLines(n.labels, 20)}
Taints:             ${n.taints.length ? n.taints.map((t, i) => (i ? ' '.repeat(20) : '') + `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`).join('\n') : '<none>'}
Unschedulable:      false
Allocatable:
  cpu:                ${fmtCpu(n.cpu)}
  memory:             ${fmtMem(n.mem)}
  pods:               110
Non-terminated Pods:          (${pods.length} in total)
${podTable}
Allocated resources:
  (Total limits may be over 100 percent, i.e., overcommitted.)
${alloc}
Events:              <none>`;
}

function describeJob(c: Cluster, j: Job) {
  const st = c.jobStatus(j);
  const labels = { 'batch.kubernetes.io/controller-uid': j.uid, 'batch.kubernetes.io/job-name': j.name, 'controller-uid': j.uid, 'job-name': j.name };
  return `Name:             ${j.name}
Namespace:        ${j.ns}
Selector:         batch.kubernetes.io/controller-uid=${j.uid}
Labels:           ${labelLines(labels)}
Annotations:      ${j.manual ? 'cronjob.kubernetes.io/instantiate: manual' : '<none>'}${j.owner ? `\nControlled By:    CronJob/${j.owner}` : ''}
Parallelism:      ${j.parallelism}
Completions:      ${j.completions}
Completion Mode:  NonIndexed
Suspend:          ${j.suspend}
Backoff Limit:    ${j.backoffLimit}
Start Time:       ${stamp(c, j.created)}${j.condition === 'Complete' ? `\nCompleted At:     ${stamp(c, j.finishedAt!)}\nDuration:         ${human((j.finishedAt! - j.created) * SECONDS_PER_TICK)}` : ''}
Pods Statuses:    ${st.active} Active (${st.ready} Ready) / ${st.succeeded} Succeeded / ${st.failed} Failed
Pod Template:
${podTemplate(j.template)}
${eventsBlock(c, c.events.filter((e) => e.ns === j.ns && e.object === `job/${j.name}`))}`;
}

function describeCron(c: Cluster, cj: CronJob) {
  const active = [...c.jobs.values()].filter((j) => j.ns === cj.ns && j.owner === cj.name && !j.manual && !j.condition);
  return `Name:                          ${cj.name}
Namespace:                     ${cj.ns}
Schedule:                      ${cj.schedule}
Concurrency Policy:            ${cj.concurrencyPolicy}
Suspend:                       ${cj.suspend ? 'True' : 'False'}
Time Zone:                     <unset>
Successful Job History Limit:  ${cj.successfulJobsHistoryLimit}
Failed Job History Limit:      ${cj.failedJobsHistoryLimit}
Starting Deadline Seconds:     <unset>
Pod Template:
${podTemplate(cj.template)}
Last Schedule Time:  ${cj.lastSchedule === undefined ? '<unset>' : `${age(c, cj.lastSchedule)} ago`}
Active Jobs:         ${active.length ? active.map((j) => j.name).join(', ') : '<none>'}
${eventsBlock(c, c.events.filter((e) => e.ns === cj.ns && e.object === `cronjob/${cj.name}`))}`;
}

function describeDs(c: Cluster, ds: DaemonSet) {
  const st = c.dsStatus(ds);
  const pods = c.podsOf(ds.ns, ds.name, 'DaemonSet').filter((p) => p.status !== 'Terminating');
  return `Name:           ${ds.name}
Namespace:      ${ds.ns}
Selector:       ${labelText(ds.template.labels)}
Node-Selector:  ${labelText(ds.template.nodeSelector)}
Labels:         ${labelLines(ds.labels, 16)}
Desired Number of Nodes Scheduled: ${st.desired}
Current Number of Nodes Scheduled: ${st.current}
Number of Nodes Scheduled with Up-to-date Pods: ${st.upToDate}
Number of Nodes Scheduled with Available Pods: ${st.available}
Number of Nodes Misscheduled: 0
Pods Status:  ${pods.filter((p) => p.status === 'Running').length} Running / ${pods.filter((p) => p.status !== 'Running').length} Waiting / 0 Succeeded / 0 Failed
Pod Template:
${podTemplate(ds.template)}
${eventsBlock(c, c.events.filter((e) => e.ns === ds.ns && e.object === `daemonset/${ds.name}`))}`;
}

// ---- logs and exec -----------------------------------------------------

function pickContainer(p: Pod, want: string | undefined): { name: string; logs: string[]; previous: string[]; hasLast: boolean; waiting: string | null; init: boolean } {
  const t = p.template;
  const all = [t.name, ...t.sidecars.map((x) => x.name), ...t.initContainers.map((x) => `${x.name} (init)`)].join(', ');
  const name = want ?? t.name;
  if (name === t.name) {
    const waiting = p.mainFinished || p.status === 'Running' || p.status === 'CrashLoopBackOff' || p.status === 'Succeeded' || p.status === 'Failed' ? null
      : t.initContainers.length && (p.status === 'Initializing' || p.initDone < t.initContainers.length || p.status === 'ContainerCreating') ? 'PodInitializing' : p.status;
    return { name, logs: p.logs, previous: p.previousLogs, hasLast: !!p.last && p.restarts > 0, waiting, init: false };
  }
  const si = t.sidecars.findIndex((x) => x.name === name);
  if (si >= 0) { const st = p.sides[si]; return { name, logs: st.logs, previous: st.previousLogs, hasLast: st.restarts > 0, waiting: st.status === 'Waiting' ? 'PodInitializing' : null, init: false }; }
  const ii = t.initContainers.findIndex((x) => x.name === name);
  if (ii >= 0) { const st = p.inits[ii]; return { name, logs: st.logs, previous: st.previousLogs, hasLast: st.restarts > 0, waiting: st.status === 'Waiting' && !st.last ? 'PodInitializing' : null, init: true }; }
  throw new Error(`error: container ${name} is not valid for pod ${p.name} out of: ${all}`);
}

function logs(c: Cluster, rest: string[], observe?: Observer): Out[] {
  const p = parse(rest, 'logs', { ...NS_FLAGS, '--container': 'value', '--previous': 'bool', '--tail': 'value', '--follow': 'bool', '--all-containers': 'bool', '--timestamps': 'bool' }, { ...ALIASES, '-p': '--previous', '-f': '--follow' });
  if (b(p, '--follow')) throw new Error('error: this sandbox has no -f: run kubectl logs again to see new lines.');
  if (b(p, '--all-containers') || b(p, '--timestamps')) throw new Error(`error: ${b(p, '--all-containers') ? '--all-containers' : '--timestamps'} is real, but this sandbox does not model it. Use -c <container>.`);
  const ns = nsOf(c, p);
  if (!p.pos[0]) throw new Error('error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.\nPOD or TYPE/NAME is a required argument for the logs command');
  const { pod, note } = podRef(c, ns, p.pos[0], 'logs');
  const want = s(p, '--container') ?? p.pos[1];
  const ctr = pickContainer(pod, want);
  const shown = b(p, '--previous') ? ctr.previous : ctr.logs;
  observe?.({ verb: 'logs', kind: 'pods', name: pod.name, ns, pod, container: ctr.name, previous: b(p, '--previous'), text: shown.join('\n') });
  const out: Out[] = [...note];
  const t = pod.template;
  const count = 1 + t.sidecars.length + t.initContainers.length;
  if (!want && count > 1) out.push(...lines(`Defaulted container "${t.name}" out of: ${[t.name, ...t.sidecars.map((x) => x.name), ...t.initContainers.map((x) => `${x.name} (init)`)].join(', ')}`, 'dim'));
  if (b(p, '--previous')) {
    if (!ctr.hasLast) return [...out, ...lines(`Error from server (BadRequest): previous terminated container "${ctr.name}" in pod "${pod.name}" not found`, 'err')];
    return [...out, ...lines(tail(ctr.previous, s(p, '--tail')).join('\n'))];
  }
  // A pod no node has taken has no container to read from: on kind v1.36.1
  // `kubectl logs` of one printed nothing and exited 0. "waiting to start:
  // Pending" was this sandbox's invention; Pending is not a container reason.
  if (!pod.node) return out;
  if (ctr.waiting) return [...out, ...lines(`Error from server (BadRequest): container "${ctr.name}" in pod "${pod.name}" is waiting to start: ${ctr.waiting}`, 'err')];
  return [...out, ...lines(tail(ctr.logs, s(p, '--tail')).join('\n'))];
}

const tail = (l: string[], n?: string) => (n === undefined || Number(n) < 0 ? l : l.slice(-Number(n)));

/** "web-abc12", "pod/web-abc12" or "deploy/web": logs and exec accept an owner and pick one of its pods. */
function podRef(c: Cluster, ns: string, ref: string, verb: string): { pod: Pod; note: Out[] } {
  const slash = ref.indexOf('/');
  if (slash < 0 || /^(pod|pods|po)\//.test(ref)) {
    const name = ref.slice(slash + 1);
    const pod = c.findPod(ns, name);
    if (!pod) throw new Error(verb === 'logs' ? `error: error from server (NotFound): pods "${name}" not found in namespace "${ns}"` : `Error from server (NotFound): pods "${name}" not found`);
    return { pod, note: [] };
  }
  const kind = kindOf(ref.slice(0, slash));
  const name = ref.slice(slash + 1);
  const owned = (k: Parameters<Cluster['podsOf']>[2], owner: string) => c.podsOf(ns, owner, k).filter((x) => x.status !== 'Terminating');
  let pods: Pod[];
  if (kind === 'deployments') {
    c.deployment(name, ns);
    pods = [...c.replicasets.values()].filter((r) => r.ns === ns && r.owner === name).flatMap((r) => owned('ReplicaSet', r.name));
  } else if (kind === 'jobs') {
    if (!c.jobs.has(key(ns, name))) throw notFound('jobs', name);
    pods = owned('Job', name);
  } else if (kind === 'daemonsets') {
    if (!c.daemonsets.has(key(ns, name))) throw notFound('daemonsets', name);
    pods = owned('DaemonSet', name);
  } else throw new Error(`error: cannot attach to *v1.${info(kind).kind}: selector for *v1.${info(kind).kind} not implemented`);
  if (!pods.length) throw new Error(`error: timed out waiting for the condition`);
  // Like kubectl: prefer a running pod, newest first among equals.
  const pod = pods.sort((a, b2) => Number(b2.status === 'Running') - Number(a.status === 'Running') || b2.created - a.created)[0];
  return { pod, note: pods.length > 1 ? lines(`Found ${pods.length} pods, using pod/${pod.name}`, 'dim') : [] };
}

function exec(c: Cluster, rest: string[], observe?: Observer): Out[] {
  const p = parse(rest, 'exec', { ...NS_FLAGS, '--container': 'value', '--stdin': 'bool', '--tty': 'bool' }, { ...ALIASES, '-i': '--stdin', '-t': '--tty' });
  const ns = nsOf(c, p);
  if (!p.pos[0]) throw new Error('error: expected \'exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...]\'.\nPOD or TYPE/NAME is a required argument for the exec command');
  if (!p.after || !p.after.length) throw new Error('error: you must specify at least one command for the container');
  const { pod } = podRef(c, ns, p.pos[0], 'exec');
  const [cmd, ...a] = p.after;
  if (['sh', 'bash', '/bin/sh', '/bin/bash'].includes(cmd)) throw new Error('error: this sandbox has no shell inside its containers. It runs single commands: cat <file>, ls <dir>, env, printenv [NAME], id.');
  const t = pod.template;
  const want = s(p, '--container') ?? t.name;
  if (![t.name, ...t.sidecars.map((x) => x.name), ...t.initContainers.filter((x) => x.restartPolicy === 'Always').map((x) => x.name)].includes(want)) {
    throw new Error(`error: container ${want} is not valid for pod ${pod.name}`);
  }
  const running = want === t.name ? pod.status === 'Running' && !pod.mainFinished : (pod.sides.find((x) => x.name === want) ?? pod.inits.find((x) => x.name === want))?.status === 'Running';
  if (!running) throw new Error(`error: Internal error occurred: unable to upgrade connection: container not found ("${want}")`);
  observe?.({ verb: 'exec', kind: 'pods', name: pod.name, ns, pod, container: want, text: p.after.join(' ') });
  const out: Out[] = !s(p, '--container') && (t.sidecars.length || t.initContainers.length) ? lines(`Defaulted container "${t.name}" out of: ${[t.name, ...t.sidecars.map((x) => x.name), ...t.initContainers.map((x) => `${x.name} (init)`)].join(', ')}`, 'dim') : [];
  // Files mounted into this container: ConfigMap and Secret volumes.
  const ctrMounts = want === t.name ? t.mounts : (t.sidecars.find((x) => x.name === want) ?? t.initContainers.find((x) => x.name === want))!.mounts;
  const visible = Object.entries(pod.files).filter(([f]) => ctrMounts.some((m) => f === m.mountPath || f.startsWith(m.mountPath + '/')));
  const env = want === t.name ? pod.env : (pod.sides.find((x) => x.name === want) ?? pod.inits.find((x) => x.name === want))!.env;
  const fullEnv = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOSTNAME: pod.name, ...env, KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443', HOME: '/root' };
  switch (cmd) {
    case 'cat': {
      if (!a.length) throw new Error('cat: this sandbox needs a file name');
      const res: string[] = [];
      for (const f of a) {
        const hit = visible.find(([x]) => x === f && !x.endsWith('/'));
        if (!hit) { out.push(...lines(`cat: can't open '${f}': No such file or directory`, 'err')); continue; }
        res.push(hit[1]);
      }
      return [...out, ...lines(res.join('\n'))];
    }
    case 'ls': {
      const dir = (a.filter((x) => !x.startsWith('-'))[0] ?? '/').replace(/\/$/, '');
      if (a.some((x) => x.startsWith('-'))) throw new Error('ls: this sandbox lists names only (no -l or -a)');
      const inside = visible.filter(([f]) => f.startsWith(dir + '/')).map(([f]) => f.slice(dir.length + 1).split('/')[0]).filter(Boolean);
      if (!inside.length && !visible.some(([f]) => f === dir + '/')) return [...out, ...lines(`ls: ${dir}: No such file or directory`, 'err')];
      return [...out, ...lines([...new Set(inside)].sort().join('\n'))];
    }
    case 'env': case 'printenv':
      if (cmd === 'printenv' && a[0]) return [...out, ...lines((fullEnv as Record<string, string>)[a[0]] ?? '')];
      return [...out, ...lines(Object.entries(fullEnv).map(([k, v]) => `${k}=${v}`).join('\n'))];
    case 'id': {
      const sc = { ...t.podSc, ...Object.fromEntries(Object.entries(t.sc).filter(([, v]) => v !== undefined)) } as { runAsUser?: number };
      const uid = sc.runAsUser ?? ({ 'panda/hello-nonroot:1.0': 1000 } as Record<string, number>)[t.image] ?? 0;
      return [...out, ...lines(uid === 0 ? 'uid=0(root) gid=0(root) groups=0(root)' : `uid=${uid} gid=0(root) groups=0(root)`)];
    }
    default:
      throw new Error(`error: this sandbox's exec runs only cat, ls, env, printenv and id ("${cmd}" is a real command, just not one it can fake honestly)`);
  }
}

// ---- create and run ----------------------------------------------------

function refuseCommand(p: Parsed) {
  if (p.after && p.after.length) throw new Error('error: the panda/* images have their behaviour built in, so this sandbox cannot run a command after --. Leave it off.');
}

function create(c: Cluster, rest: string[], observe?: Observer): Out[] {
  const what = rest[0];
  const sub = rest.slice(1);
  switch (what) {
    case 'deployment': case 'deploy': {
      const p = parse(sub, 'create deployment', { ...NS_FLAGS, '--image': 'multi', '--replicas': 'value', '--port': 'value' });
      refuseCommand(p);
      const name = p.pos[0];
      const imgs = (p.f['--image'] as string[]) ?? [];
      if (!name || !imgs.length) throw new Error('error: required flag(s) "image" not set');
      if (imgs.length > 1) throw new Error('error: this sandbox makes one container per deployment from --image; add more with kubectl patch');
      if (p.f['--port']) throw new Error('error: --port is real, but ports and Services are taught with their own simulator');
      const ns = nsOf(c, p);
      c.namespace(ns);
      const warning = psaWarning(c, ns, defaultTemplate(imgs[0], { labels: { app: name } }));
      c.createDeployment(name, imgs[0], Number(s(p, '--replicas') ?? 1), ns);
      return [...warn(warning), ...say(`deployment.apps/${name} created`)];
    }
    case 'quota': case 'resourcequota': {
      const p = parse(sub, 'create quota', { ...NS_FLAGS, '--hard': 'value' });
      const name = p.pos[0];
      const m = /^pods=(\d+)$/.exec(s(p, '--hard') ?? '');
      if (!name || !m) throw new Error('error: this sandbox supports kubectl create quota <name> --hard=pods=N');
      const ns = nsOf(c, p);
      c.writable(ns, 'resourcequotas', name);
      if (c.quotas.has(key(ns, name))) throw new Error(`Error from server (AlreadyExists): resourcequotas "${name}" already exists`);
      if (c.quotaIn(ns)) throw new Error(`error: this sandbox keeps one quota per namespace, and ${ns} already has one`);
      c.quotas.set(key(ns, name), { ns, name, pods: Number(m[1]), created: c.tick });
      return say(`resourcequota/${name} created`);
    }
    case 'namespace': case 'ns': {
      const p = parse(sub, 'create namespace', {});
      if (!p.pos[0]) throw new Error('error: exactly one NAME is required, got 0');
      c.createNamespace(p.pos[0]);
      return say(`namespace/${p.pos[0]} created`);
    }
    case 'configmap': case 'cm': case 'secret': {
      const isSecret = what === 'secret';
      let args = sub;
      if (isSecret) {
        if (sub[0] !== 'generic') throw new Error(sub[0] === 'tls' || sub[0] === 'docker-registry' ? `error: secret ${sub[0]} is real, but this sandbox models generic secrets only` : 'error: try kubectl create secret generic <name> --from-literal=KEY=value');
        args = sub.slice(1);
      }
      const p = parse(args, `create ${what}`, { ...NS_FLAGS, '--from-literal': 'multi', '--from-file': 'multi', '--from-env-file': 'multi', '--dry-run': 'value', '--output': 'value' });
      const name = p.pos[0];
      if (!name) throw new Error('error: exactly one NAME is required, got 0');
      if (p.f['--from-file'] || p.f['--from-env-file']) throw new Error('error: --from-file is real, but this sandbox has no files to read. Use --from-literal=KEY=value.');
      const data: Record<string, string> = {};
      for (const lit of (p.f['--from-literal'] as string[]) ?? []) {
        const i = lit.indexOf('=');
        if (i <= 0) throw new Error(`error: invalid literal source ${lit}, expected key=value`);
        data[lit.slice(0, i)] = lit.slice(i + 1);
      }
      const ns = nsOf(c, p);
      const dry = s(p, '--dry-run');
      if (dry !== undefined && dry !== 'client') throw new Error('error: this sandbox supports --dry-run=client only');
      const obj = { ns, name, data, created: c.tick, labels: {}, ...(isSecret ? { type: 'Opaque' as const } : {}) };
      if (dry) {
        const out = s(p, '--output');
        if (out !== 'yaml') return say(`${isSecret ? 'secret' : 'configmap'}/${name} created (dry run)`);
        const o = isSecret ? secretObj(c, obj as never) : configMapObj(c, obj);
        const m = o.metadata as Record<string, unknown>;
        for (const k of ['creationTimestamp', 'resourceVersion', 'uid']) delete m[k];
        return say(toYaml(o));
      }
      if (s(p, '--output')) throw new Error('error: -o is supported here together with --dry-run=client only');
      c.writable(ns, isSecret ? 'secrets' : 'configmaps', name);
      const store = isSecret ? c.secrets : c.configmaps;
      if (store.has(key(ns, name))) throw new Error(`error: failed to create ${isSecret ? 'secret' : 'configmap'}: ${isSecret ? 'secrets' : 'configmaps'} "${name}" already exists`);
      (store as Map<string, unknown>).set(key(ns, name), obj);
      observe?.({ verb: 'create', kind: isSecret ? 'secrets' : 'configmaps', name, ns });
      return say(`${isSecret ? 'secret' : 'configmap'}/${name} created`);
    }
    case 'job': {
      const p = parse(sub, 'create job', { ...NS_FLAGS, '--image': 'value', '--from': 'value' });
      refuseCommand(p);
      const name = p.pos[0];
      const ns = nsOf(c, p);
      const from = s(p, '--from');
      if (!name) throw new Error('error: exactly one NAME is required, got 0');
      if (!s(p, '--image') && !from) throw new Error('error: either --image or --from must be specified');
      if (from) {
        const [k, n] = from.split('/');
        if (kindOf(k) !== 'cronjobs') throw new Error(`error: from must be an existing cronjob: ${from}`);
        const cj = c.cronjobs.get(key(ns, n));
        if (!cj) throw new Error(`Error from server (NotFound): cronjobs.batch "${n}" not found`);
        c.createJob(ns, name, clone(cj.template), { backoffLimit: cj.backoffLimit, owner: cj.name, manual: true });
      } else {
        c.namespace(ns);
        c.createJob(ns, name, defaultTemplate(s(p, '--image')!, { restartPolicy: 'Never', liveness: false }));
      }
      observe?.({ verb: 'create', kind: 'jobs', name, ns });
      return say(`job.batch/${name} created`);
    }
    case 'cronjob': case 'cj': {
      const p = parse(sub, 'create cronjob', { ...NS_FLAGS, '--image': 'value', '--schedule': 'value', '--restart': 'value' });
      refuseCommand(p);
      const name = p.pos[0];
      const ns = nsOf(c, p);
      if (!name) throw new Error('error: exactly one NAME is required, got 0');
      if (!s(p, '--image')) throw new Error('error: required flag(s) "image" not set');
      const schedule = s(p, '--schedule');
      if (!schedule) throw new Error('error: required flag(s) "schedule" not set');
      try { parseCron(schedule); } catch (e) { throw new Error(`error: failed to create cronjob: CronJob.batch "${name}" is invalid: spec.schedule: Invalid value: "${schedule}": ${(e as Error).message}`); }
      const restart = s(p, '--restart') ?? 'OnFailure';
      if (restart !== 'OnFailure' && restart !== 'Never') throw new Error(`error: invalid restart policy: ${restart}`);
      c.writable(ns, 'cronjobs.batch', name);
      if (c.cronjobs.has(key(ns, name))) throw new Error(`error: failed to create cronjob: cronjobs.batch "${name}" already exists`);
      c.cronjobs.set(key(ns, name), newCron(c, ns, name, schedule, defaultTemplate(s(p, '--image')!, { restartPolicy: restart as 'OnFailure', liveness: false })));
      return say(`cronjob.batch/${name} created`);
    }
    case undefined:
      throw new Error('error: Required resource not specified.\nUse "kubectl explain <resource>" for a detailed description of that resource (e.g. kubectl explain pods).');
    default:
      if (ELSEWHERE[what]) kindOf(what);
      throw new Error(`error: this sandbox can create deployment, job, cronjob, namespace, configmap, secret generic and quota ("${what}" is not one of them)`);
  }
}

export function newCron(c: Cluster, ns: string, name: string, schedule: string, template: Template, extra: Partial<CronJob> = {}): CronJob {
  return { ns, name, schedule, suspend: false, concurrencyPolicy: 'Allow', template, backoffLimit: 6, created: c.tick, lastMinute: c.minuteAt(c.tick), missed: [], successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1, ...extra };
}

/** The "Warning: would violate PodSecurity" line kubectl prints when a namespace enforces or warns. */
function psaWarning(c: Cluster, ns: string, t: Template): string[] {
  const level = c.psaLevel(ns, 'warn') ?? c.psaLevel(ns, 'enforce');
  if (!level) return [];
  const v = psaViolations(t, level);
  return v.length ? [`Warning: would violate PodSecurity "${level}:latest": ${v.map((x) => x.long).join(', ')}`] : [];
}

function runPod(c: Cluster, rest: string[]): Out[] {
  const p = parse(rest, 'run', { ...NS_FLAGS, '--image': 'value', '--restart': 'value', '--labels': 'value', '--overrides': 'value', '--dry-run': 'value', '--output': 'value', '--rm': 'bool', '--stdin': 'bool', '--tty': 'bool' }, { ...ALIASES, '-l': '--labels', '-i': '--stdin', '-t': '--tty' });
  refuseCommand(p);
  if (b(p, '--rm') || b(p, '--stdin') || b(p, '--tty')) throw new Error('error: -it and --rm attach a terminal to the pod; this sandbox has none. Run it, then use kubectl logs.');
  const name = p.pos[0];
  if (!name) throw new Error('error: NAME is required for run');
  const image = s(p, '--image');
  if (!image) throw new Error('error: required flag(s) "image" not set');
  const ns = nsOf(c, p);
  const restart = s(p, '--restart') ?? 'Always';
  if (!['Always', 'Never', 'OnFailure'].includes(restart)) throw new Error(`error: invalid restart policy: ${restart}`);
  const labels: Record<string, string> = {};
  for (const kv of (s(p, '--labels') ?? `run=${name}`).split(',')) { const [k, v] = kv.split('='); labels[k] = v ?? ''; }
  // kubectl run names the container after the pod, as the real one does.
  const t = defaultTemplate(image, { name, labels, restartPolicy: restart as 'Always', liveness: false });
  let warnings: string[] = [];
  if (s(p, '--overrides')) {
    let o: any;
    try { o = JSON.parse(s(p, '--overrides')!); } catch { throw new Error('error: --overrides is not valid JSON (wrap it in single quotes)'); }
    const r = withWarnings(() => {
      if (o.spec) applyPodSpec(t, o.spec, 'spec');
      const extra = Object.keys(o).filter((k) => k !== 'spec' && k !== 'apiVersion' && k !== 'kind');
      if (extra.length) throw new Error(`error: this sandbox reads only spec from --overrides (not ${extra.join(', ')})`);
    });
    warnings = r.warnings;
  }
  if (s(p, '--dry-run')) throw new Error('error: --dry-run is supported on create configmap and create secret here');
  c.writable(ns, 'pods', name);
  if (c.findPod(ns, name)) throw new Error(`Error from server (AlreadyExists): pods "${name}" already exists`);
  const refused = c.admit(ns, name, t);
  if (refused) throw new Error(`Error from server (Forbidden): ${refused}`);
  c.newPod(ns, name, '', null, t, labels);
  return [...warn(warnings), ...warn(psaWarning(c, ns, t).filter(() => !c.psaLevel(ns, 'enforce'))), ...say(`pod/${name} created`)];
}

// ---- set ---------------------------------------------------------------

function set(c: Cluster, rest: string[]): Out[] {
  const [what, ...more] = rest;
  const p = parse(more, `set ${what}`, { ...NS_FLAGS, '--requests': 'value', '--limits': 'value', '--from': 'value', '--container': 'value', '--list': 'bool', '--keys': 'value', '--prefix': 'value', '--overwrite': 'bool' });
  const t = target(p.pos, 'deployments');
  const ns = nsOf(c, p);
  if (t.kind !== 'deployments' && t.kind !== 'daemonsets') throw new Error('error: the sandbox can set fields on deployments and daemonsets only (a Job\'s pod template cannot be changed after it is created)');
  const tpl = (change: (x: Template) => void) => {
    if (t.kind === 'deployments') return c.updateTemplate(t.name, change, ns);
    const ds = c.daemonsets.get(key(ns, t.name));
    if (!ds) throw notFound('daemonsets', t.name);
    const next = clone(ds.template); change(next);
    if (JSON.stringify(next) === JSON.stringify(ds.template)) return false;
    ds.template = next; ds.generation++; return true;
  };
  const current = () => t.kind === 'deployments' ? c.deployment(t.name, ns).template : c.daemonsets.get(key(ns, t.name))?.template;
  if (!current()) throw notFound(t.kind, t.name);
  const q = `${qualified(t.kind)}/${t.name}`;
  const pickCtr = (x: Template) => {
    const name = s(p, '--container');
    if (!name || name === x.name) return x as { env: Record<string, string>; envRefs: Template['envRefs'] };
    const sc = x.sidecars.find((y) => y.name === name) ?? x.initContainers.find((y) => y.name === name);
    if (!sc) throw new Error(`error: unable to find container named ${name}`);
    return sc;
  };
  if (what === 'image') {
    const pairs = t.rest.filter((a) => a.includes('='));
    if (!pairs.length) throw new Error('error: at least one image update is required');
    tpl((x) => {
      for (const pair of pairs) {
        const [ctr, image] = pair.split('=');
        if (ctr === x.name || ctr === '*') x.image = image;
        else {
          const sc = x.sidecars.find((y) => y.name === ctr) ?? x.initContainers.find((y) => y.name === ctr);
          if (!sc) throw new Error(`error: unable to find container named "${ctr}"`);
          sc.image = image;
        }
      }
    });
    return say(`${q} image updated`);
  }
  if (what === 'resources') {
    const req = s(p, '--requests'), lim = s(p, '--limits');
    if (!req && !lim) throw new Error('error: you must specify an update to requests or limits (in the form of --requests/--limits)');
    tpl((x) => {
      for (const [k, v] of (req ?? '').split(',').filter(Boolean).map((y) => y.split('='))) {
        if (k === 'cpu') x.requests.cpu = parseCpu(v); else if (k === 'memory') x.requests.mem = parseMem(v); else throw new Error(`error: this sandbox models cpu and memory requests, not ${k}`);
      }
      for (const [k, v] of (lim ?? '').split(',').filter(Boolean).map((y) => y.split('='))) {
        if (k === 'memory') x.limits.mem = parseMem(v); else throw new Error(`error: this sandbox models memory limits only, not ${k}`);
      }
    });
    return say(`${q} resource requirements updated`);
  }
  if (what === 'env') {
    if (b(p, '--list')) {
      const x = pickCtr(current()!) as { env: Record<string, string>; envRefs: Template['envRefs'] };
      return say([`# ${q}, container ${s(p, '--container') ?? current()!.name}`, ...x.envRefs.map((r) => `# ${r.name} from ${r.kind === 'configMap' ? 'configmap' : 'secret'} ${r.ref}, key ${r.key}`), ...Object.entries(x.env).map(([k, v]) => `${k}=${v}`)].join('\n'));
    }
    if (s(p, '--keys') || s(p, '--prefix')) throw new Error('error: --keys and --prefix are real, but this sandbox does not model them');
    const from = s(p, '--from');
    const pairs = t.rest.filter((a) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
    const unset = t.rest.filter((a) => /^[A-Za-z_][A-Za-z0-9_]*-$/.test(a)).map((a) => a.slice(0, -1));
    if (!pairs.length && !from && !unset.length) throw new Error('error: at least one environment variable must be provided');
    let refs: Template['envRefs'] = [];
    if (from) {
      // kubectl reads the ConfigMap or Secret *now* and writes one env entry
      // per key that exists now. A key added to the ConfigMap later never
      // reaches the pod, even after a restart (seen on kind v1.36.1: the
      // Deployment got env[].valueFrom.configMapKeyRef, not envFrom).
      const [k, n] = from.split('/');
      const kind = k === 'configmap' || k === 'cm' ? 'configMap' : k === 'secret' ? 'secret' : null;
      if (!kind) throw new Error(`error: from must be a configmap or secret, got ${k}`);
      const src = kind === 'configMap' ? c.configmaps.get(key(ns, n)) : c.secrets.get(key(ns, n));
      if (!src) throw new Error(`Error from server (NotFound): ${kind === 'configMap' ? 'configmaps' : 'secrets'} "${n}" not found`);
      refs = Object.keys(src.data).map((k2) => ({ name: k2, kind, ref: n, key: k2 }));
    }
    tpl((x) => {
      const ctr = pickCtr(x);
      for (const r of refs) { delete ctr.env[r.name]; ctr.envRefs = [...ctr.envRefs.filter((y) => y.name !== r.name), r]; }
      for (const pr of pairs) { const i = pr.indexOf('='); const k2 = pr.slice(0, i); ctr.envRefs = ctr.envRefs.filter((y) => y.name !== k2); ctr.env[k2] = pr.slice(i + 1); }
      for (const u of unset) { delete ctr.env[u]; ctr.envRefs = ctr.envRefs.filter((y) => y.name !== u); }
    });
    return say(`${q} env updated`);
  }
  throw new Error('error: try kubectl set image | resources | env');
}

// ---- patch and apply ---------------------------------------------------

function patch(c: Cluster, rest: string[], observe?: Observer): Out[] {
  const p = parse(rest, 'patch', { ...NS_FLAGS, '--patch': 'value', '--type': 'value' });
  const t = target(p.pos);
  const ns = nsOf(c, p);
  const raw = s(p, '--patch');
  if (!raw) throw new Error('error: must specify --patch or --patch-file containing the contents of the patch');
  const type = s(p, '--type') ?? 'strategic';
  if (type === 'json') throw new Error('error: --type=json is real, but this sandbox applies merge and strategic patches only');
  if (type !== 'strategic' && type !== 'merge') throw new Error(`error: --type must be one of [json merge strategic], not "${type}"`);
  let body: any;
  try { body = JSON.parse(raw); } catch { throw new Error('Error from server (BadRequest): json: cannot unmarshal string into Go value of type map[string]interface {}'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Error from server (BadRequest): json: cannot unmarshal array into Go value of type map[string]interface {}');
  const q = `${qualified(t.kind)}/${t.name}`;
  const { result: changed, warnings } = withWarnings(() => patchObject(c, t.kind, ns, t.name, body, observe));
  return [...warn(warnings), ...say(`${q} patched${changed ? '' : ' (no change)'}`)];
}

const invalid = (kind: string, name: string, e: unknown) => {
  if (e instanceof Invalid) return new Error(`The ${info(kind).kind} "${name}" is invalid: ${e.message}`);
  return e as Error;
};

function patchTemplate(tpl: Template, spec: any, kind: string, name: string) {
  if (spec.metadata) applyTemplateMeta(tpl, spec.metadata);
  const extra = Object.keys(spec).filter((k) => k !== 'metadata' && k !== 'spec');
  if (extra.length) throw new Error(`error: this sandbox does not model spec.template.${extra[0]}`);
  try { if (spec.spec) applyPodSpec(tpl, spec.spec); } catch (e) { throw invalid(kind, name, e); }
}

/** Apply a patch body to one stored object. Returns whether anything changed. */
function patchObject(c: Cluster, kind: string, ns: string, name: string, body: any, observe?: Observer): boolean {
  const keys = (o: any, allowed: string[], path: string) => { for (const k of Object.keys(o ?? {})) if (!allowed.includes(k)) throw new Error(`error: this sandbox does not model ${path}.${k} on ${kind}`); };
  keys(body, ['spec', 'metadata', 'data', 'stringData'], '');
  observe?.({ verb: 'patch', kind, name, ns });
  switch (kind) {
    case 'deployments': {
      const d = c.deployment(name, ns);
      keys(body.spec, ['replicas', 'template', 'progressDeadlineSeconds'], 'spec');
      const before = JSON.stringify([d.replicas, d.template, d.progressDeadlineSeconds]);
      if (body.spec?.replicas !== undefined) d.replicas = Number(body.spec.replicas);
      if (body.spec?.progressDeadlineSeconds !== undefined) {
        const v = Number(body.spec.progressDeadlineSeconds);
        if (!Number.isInteger(v) || v <= 0) throw new Error('error: this sandbox takes progressDeadlineSeconds as a whole number of seconds above 0');
        d.progressDeadlineSeconds = v;
      }
      if (body.spec?.template) c.updateTemplate(name, (x) => patchTemplate(x, body.spec.template, kind, name), ns);
      if (body.metadata) labelsFrom(d.labels, body.metadata);
      return before !== JSON.stringify([d.replicas, d.template, d.progressDeadlineSeconds]);
    }
    case 'daemonsets': {
      const ds = c.daemonsets.get(key(ns, name));
      if (!ds) throw notFound(kind, name);
      keys(body.spec, ['template'], 'spec');
      if (!body.spec?.template) return false;
      const next = clone(ds.template);
      patchTemplate(next, body.spec.template, kind, name);
      if (JSON.stringify(next) === JSON.stringify(ds.template)) return false;
      ds.template = next; ds.generation++;
      return true;
    }
    case 'jobs': {
      const j = c.jobs.get(key(ns, name));
      if (!j) throw notFound(kind, name);
      keys(body.spec, ['template', 'suspend', 'backoffLimit', 'parallelism'], 'spec');
      // The Job's pod template is immutable once created. The real error
      // prints the whole template as a Go struct; it ends the same way.
      if (body.spec?.template) throw new Error(`The Job "${name}" is invalid: spec.template: Invalid value: {...the whole pod template...}: field is immutable`);
      const before = JSON.stringify([j.suspend, j.backoffLimit, j.parallelism]);
      if (body.spec?.suspend !== undefined) j.suspend = Boolean(body.spec.suspend);
      if (body.spec?.backoffLimit !== undefined) j.backoffLimit = Number(body.spec.backoffLimit);
      if (body.spec?.parallelism !== undefined) j.parallelism = Number(body.spec.parallelism);
      return before !== JSON.stringify([j.suspend, j.backoffLimit, j.parallelism]);
    }
    case 'cronjobs': {
      const cj = c.cronjobs.get(key(ns, name));
      if (!cj) throw notFound(kind, name);
      keys(body.spec, ['suspend', 'schedule', 'concurrencyPolicy', 'jobTemplate', 'successfulJobsHistoryLimit', 'failedJobsHistoryLimit', 'timeZone', 'startingDeadlineSeconds'], 'spec');
      const sp = body.spec ?? {};
      if (sp.startingDeadlineSeconds !== undefined) throw new Error('error: startingDeadlineSeconds is real, but this sandbox does not model it');
      if (sp.timeZone !== undefined && sp.timeZone !== null && sp.timeZone !== 'Etc/UTC' && sp.timeZone !== 'UTC') {
        throw new Error(`error: this sandbox's clock knows only UTC (timeZone "${sp.timeZone}")`);
      }
      const before = JSON.stringify(cj);
      if (sp.schedule !== undefined) {
        try { parseCron(sp.schedule); } catch (e) { throw new Error(`The CronJob "${name}" is invalid: spec.schedule: Invalid value: "${sp.schedule}": ${(e as Error).message}`); }
        cj.schedule = sp.schedule;
      }
      if (sp.concurrencyPolicy !== undefined) {
        if (!['Allow', 'Forbid', 'Replace'].includes(sp.concurrencyPolicy)) throw new Error(`The CronJob "${name}" is invalid: spec.concurrencyPolicy: Unsupported value: "${sp.concurrencyPolicy}": supported values: "Allow", "Forbid", "Replace"`);
        cj.concurrencyPolicy = sp.concurrencyPolicy;
      }
      if (sp.successfulJobsHistoryLimit !== undefined) cj.successfulJobsHistoryLimit = Number(sp.successfulJobsHistoryLimit);
      if (sp.failedJobsHistoryLimit !== undefined) cj.failedJobsHistoryLimit = Number(sp.failedJobsHistoryLimit);
      if (sp.jobTemplate?.spec?.template) patchTemplate(cj.template, sp.jobTemplate.spec.template, kind, name);
      if (sp.suspend !== undefined) {
        const was = cj.suspend;
        cj.suspend = Boolean(sp.suspend);
        // Unsuspending with no starting deadline starts the most recent
        // missed run at once; the older missed runs are not made up.
        if (was && !cj.suspend && cj.missed.length) { const m = cj.missed[cj.missed.length - 1]; cj.missed = []; c.fire(cj, m); }
      }
      return before !== JSON.stringify(cj);
    }
    case 'configmaps': case 'secrets': {
      const store = kind === 'configmaps' ? c.configmaps : c.secrets;
      const o = store.get(key(ns, name));
      if (!o) throw notFound(kind, name);
      const before = JSON.stringify(o.data);
      const data = body.data ?? {};
      for (const [k, v] of Object.entries(data)) {
        if (v === null) delete o.data[k];
        else o.data[k] = kind === 'secrets' ? decodeOrThrow(String(v), name, k) : String(v);
      }
      if (kind === 'secrets') for (const [k, v] of Object.entries(body.stringData ?? {})) o.data[k] = String(v);
      if (body.metadata) labelsFrom(o.labels, body.metadata);
      return before !== JSON.stringify(o.data);
    }
    case 'resourcequotas': {
      const qq = c.quotas.get(key(ns, name));
      if (!qq) throw notFound(kind, name);
      const pods = body?.spec?.hard?.pods;
      if (pods === undefined) return false;
      const before = qq.pods;
      qq.pods = Number(pods);
      return before !== qq.pods;
    }
    case 'namespaces': {
      const n = c.namespace(name);
      const before = JSON.stringify(n.labels);
      if (body.metadata) labelsFrom(n.labels, body.metadata);
      return before !== JSON.stringify(n.labels);
    }
    case 'nodes': {
      const n = c.nodes.find((x) => x.name === name);
      if (!n) throw notFound(kind, name);
      throw new Error('error: use kubectl label node and kubectl taint node here');
    }
    case 'pods':
      throw new Error('error: a pod\'s spec is almost entirely immutable; change its Deployment, Job or DaemonSet instead');
  }
  throw new Error(`error: this sandbox cannot patch ${kind}`);
}

function decodeOrThrow(v: string, name: string, k: string) {
  try { return unbase64(v); } catch { throw new Error(`The Secret "${name}" is invalid: data[${k}]: Invalid value: "<secret contents redacted>": illegal base64 data at input byte 0`); }
}

function labelsFrom(into: Record<string, string>, meta: any) {
  for (const [k, v] of Object.entries(meta.labels ?? {})) { if (v === null) delete into[k]; else into[k] = String(v); }
}

function apply(c: Cluster, rest: string[], files: Files, observe?: Observer): Out[] {
  const p = parse(rest, 'apply', { ...NS_FLAGS, '--filename': 'value' });
  const f = s(p, '--filename');
  if (!f) throw new Error('error: must specify one of -f and -k');
  if (f === '-') throw new Error('error: this terminal has no stdin to read from. Use kubectl apply -f <file> with one of the files ls shows.');
  if (!(f in files)) throw new Error(`error: the path "${f}" does not exist`);
  const docs = Array.isArray(files[f]) ? (files[f] as any[]) : [files[f]];
  const out: Out[] = [];
  for (const doc of docs) {
    const { result, warnings } = withWarnings(() => applyOne(c, clone(doc), s(p, '--namespace'), observe));
    out.push(...warn(warnings), ...say(result));
  }
  return out;
}

function applyOne(c: Cluster, doc: any, nsFlag: string | undefined, observe?: Observer): string {
  const kind = KIND_INFO.find((k) => k.kind === doc.kind);
  if (!kind) throw new Error(`error: resource mapping not found for name: "${doc.metadata?.name}" namespace: "" from "file": no matches for kind "${doc.kind}" in version "${doc.apiVersion}"`);
  const name = doc.metadata?.name;
  const ns = kind.namespaced ? (doc.metadata?.namespace ?? nsFlag ?? c.context.namespace) : '';
  const q = `${qualified(kind.plural)}/${name}`;
  observe?.({ verb: 'apply', kind: kind.plural, name, ns });
  const templateFrom = (podTpl: any, defaults: Partial<Template>) => {
    const main = podTpl?.spec?.containers?.[0];
    if (!main?.name || !main?.image) throw new Error(`The ${kind.kind} "${name}" is invalid: spec.template.spec.containers[0].image: Required value`);
    const t = defaultTemplate(main.image, { name: main.name, ...defaults });
    patchTemplate(t, podTpl, kind.plural, name);
    return t;
  };
  if (kind.namespaced) c.namespace(ns);
  switch (doc.kind) {
    case 'Namespace': {
      if (c.namespaces.has(name)) { const n = c.namespace(name); const before = JSON.stringify(n.labels); labelsFrom(n.labels, doc.metadata); return `${q} ${before === JSON.stringify(n.labels) ? 'unchanged' : 'configured'}`; }
      c.createNamespace(name); labelsFrom(c.namespace(name).labels, doc.metadata); return `${q} created`;
    }
    case 'ConfigMap': case 'Secret': {
      const store = (doc.kind === 'ConfigMap' ? c.configmaps : c.secrets) as Map<string, { data: Record<string, string> }>;
      const data: Record<string, string> = { ...Object.fromEntries(Object.entries(doc.data ?? {}).map(([k, v]) => [k, doc.kind === 'Secret' ? decodeOrThrow(String(v), name, k) : String(v)])), ...(doc.stringData ?? {}) };
      const cur = store.get(key(ns, name));
      if (cur) { const same = JSON.stringify(cur.data) === JSON.stringify(data); cur.data = data; return `${q} ${same ? 'unchanged' : 'configured'}`; }
      c.writable(ns, kind.plural, name);
      store.set(key(ns, name), { ns, name, data, created: c.tick, labels: { ...(doc.metadata.labels ?? {}) }, ...(doc.kind === 'Secret' ? { type: 'Opaque' } : {}) } as never);
      return `${q} created`;
    }
    case 'Deployment': {
      const cur = c.getDeployment(ns, name);
      // apply replaces what the file manages, rather than merging into it: a field
      // removed from the file is removed from the object (kubectl's three-way merge).
      if (cur) {
        const t = templateFrom(doc.spec.template, { labels: {} });
        const before = JSON.stringify([cur.replicas, cur.template]);
        cur.replicas = Number(doc.spec.replicas ?? 1);
        c.updateTemplate(name, (x) => { Object.assign(x, t); }, ns);
        return `${q} ${before === JSON.stringify([cur.replicas, cur.template]) ? 'unchanged' : 'configured'}`;
      }
      const t = templateFrom(doc.spec.template, {});
      c.createDeployment(name, t.image, Number(doc.spec.replicas ?? 1), ns, t);
      c.getDeployment(ns, name)!.labels = { ...(doc.metadata.labels ?? { app: name }) };
      return `${q} created`;
    }
    case 'DaemonSet': {
      const curDs = c.daemonsets.get(key(ns, name));
      if (curDs) {
        const t = templateFrom(doc.spec.template, { liveness: false });
        if (JSON.stringify(t) === JSON.stringify(curDs.template)) return `${q} unchanged`;
        curDs.template = t; curDs.generation++;
        return `${q} configured`;
      }
      c.writable(ns, 'daemonsets.apps', name);
      c.daemonsets.set(key(ns, name), { ns, name, template: templateFrom(doc.spec.template, { liveness: false }), created: c.tick, generation: 1, labels: { ...(doc.metadata.labels ?? {}) } });
      return `${q} created`;
    }
    case 'Job': {
      const cur = c.jobs.get(key(ns, name));
      const t = templateFrom(doc.spec.template, { restartPolicy: 'Never', liveness: false });
      if (cur) {
        if (JSON.stringify(cur.template) !== JSON.stringify(t)) throw new Error(`The Job "${name}" is invalid: spec.template: Invalid value: {...the whole pod template...}: field is immutable`);
        return `${q} unchanged`;
      }
      c.createJob(ns, name, t, { backoffLimit: doc.spec.backoffLimit ?? 6 });
      return `${q} created`;
    }
    case 'CronJob': {
      const sp = doc.spec;
      try { parseCron(sp.schedule); } catch (e) { throw new Error(`The CronJob "${name}" is invalid: spec.schedule: Invalid value: "${sp.schedule}": ${(e as Error).message}`); }
      if (c.cronjobs.has(key(ns, name))) return `${q} ${patchObject(c, 'cronjobs', ns, name, { spec: { ...sp, jobTemplate: undefined } }) ? 'configured' : 'unchanged'}`;
      c.writable(ns, 'cronjobs.batch', name);
      const t = templateFrom(sp.jobTemplate.spec.template, { restartPolicy: 'OnFailure', liveness: false });
      c.cronjobs.set(key(ns, name), newCron(c, ns, name, sp.schedule, t, { suspend: Boolean(sp.suspend), concurrencyPolicy: sp.concurrencyPolicy ?? 'Allow', backoffLimit: sp.jobTemplate.spec.backoffLimit ?? 6 }));
      return `${q} created`;
    }
    case 'Pod': {
      if (c.findPod(ns, name)) throw new Error(`error: a pod's spec is almost entirely immutable; delete pod ${name} first`);
      const main = doc.spec?.containers?.[0];
      const t = defaultTemplate(main.image, { name: main.name, labels: { ...(doc.metadata.labels ?? {}) }, liveness: false });
      patchTemplate(t, { spec: doc.spec }, 'pods', name);
      c.writable(ns, 'pods', name);
      const refused = c.admit(ns, name, t);
      if (refused) throw new Error(`Error from server (Forbidden): error when creating "file": ${refused}`);
      c.newPod(ns, name, '', null, t, t.labels);
      return `${q} created`;
    }
  }
  throw new Error(`error: this sandbox cannot apply a ${doc.kind}`);
}

// ---- label and taint ---------------------------------------------------

function label(c: Cluster, rest: string[], observe?: Observer): Out[] {
  const p = parse(rest, 'label', { ...NS_FLAGS, '--overwrite': 'bool', '--list': 'bool', '--all': 'bool' });
  if (b(p, '--all')) throw new Error('error: --all is real, but this sandbox labels one object at a time');
  const t = target(p.pos);
  const ns = nsOf(c, p);
  if (!t.name) throw new Error('error: resource(s) were provided, but no name was specified');
  const changes = t.rest;
  let labels: Record<string, string>;
  let onChange = () => {};
  switch (t.kind) {
    case 'nodes': { const n = c.nodes.find((x) => x.name === t.name); if (!n) throw notFound('nodes', t.name); labels = n.labels; break; }
    case 'namespaces': labels = c.namespace(t.name).labels; break;
    case 'pods': { const x = c.findPod(ns, t.name); if (!x) throw notFound('pods', t.name); labels = x.labels; break; }
    case 'deployments': labels = c.deployment(t.name, ns).labels; break;
    case 'configmaps': { const x = c.configmaps.get(key(ns, t.name)); if (!x) throw notFound('configmaps', t.name); labels = x.labels; break; }
    case 'secrets': { const x = c.secrets.get(key(ns, t.name)); if (!x) throw notFound('secrets', t.name); labels = x.labels; break; }
    case 'daemonsets': { const x = c.daemonsets.get(key(ns, t.name)); if (!x) throw notFound('daemonsets', t.name); labels = x.labels; break; }
    default: throw new Error(`error: this sandbox labels nodes, namespaces, pods, deployments, configmaps, secrets and daemonsets`);
  }
  if (b(p, '--list')) return say(Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join('\n'));
  if (!changes.length) throw new Error('error: at least one label update is required');
  const next = { ...labels };
  let removed = false;
  for (const ch of changes) {
    if (ch.endsWith('-')) {
      const k = ch.slice(0, -1);
      if (!(k in next)) return [...lines(`label "${k}" not found.`, 'dim'), ...say(`${qualified(t.kind)}/${t.name} not labeled`)];
      delete next[k]; removed = true; continue;
    }
    const i = ch.indexOf('=');
    if (i <= 0) throw new Error(`error: at least one label update is required`);
    const k = ch.slice(0, i), v = ch.slice(i + 1);
    if (k in next && next[k] !== v && !b(p, '--overwrite')) throw new Error(`error: '${k}' already has a value (${next[k]}), and --overwrite is false`);
    next[k] = v;
  }
  const warnings: string[] = [];
  if (t.kind === 'namespaces') {
    for (const mode of ['enforce', 'warn', 'audit']) {
      const v = next[`pod-security.kubernetes.io/${mode}`];
      if (v !== undefined && !['privileged', 'baseline', 'restricted'].includes(v)) {
        throw new Error(`The Namespace "${t.name}" is invalid: metadata.labels[pod-security.kubernetes.io/${mode}]: Invalid value: "${v}": must be one of privileged, baseline, restricted`);
      }
    }
    const lvl = next['pod-security.kubernetes.io/enforce'];
    if (lvl && lvl !== labels['pod-security.kubernetes.io/enforce']) warnings.push(...existingViolations(c, t.name, lvl as Level));
    onChange = () => {};
  }
  const same = JSON.stringify(next) === JSON.stringify(labels);
  for (const k of Object.keys(labels)) delete labels[k];
  Object.assign(labels, next);
  onChange();
  observe?.({ verb: 'label', kind: t.kind, name: t.name, ns });
  if (same) return say(`${qualified(t.kind)}/${t.name} not labeled`);
  return [...warn(warnings), ...say(`${qualified(t.kind)}/${t.name} ${removed && !changes.some((x) => !x.endsWith('-')) ? 'unlabeled' : 'labeled'}`)];
}

/** When enforcement is switched on, existing pods are not evicted: the API server only warns, grouped by violation. */
function existingViolations(c: Cluster, ns: string, level: Level): string[] {
  const groups = new Map<string, string[]>();
  for (const p of c.podsIn(ns).filter((x) => x.status !== 'Terminating').sort((a, b2) => a.name.localeCompare(b2.name))) {
    const v = psaViolations(p.template, level);
    if (!v.length) continue;
    const k = v.map((x) => x.short).join(', ');
    groups.set(k, [...(groups.get(k) ?? []), p.name]);
  }
  if (!groups.size) return [];
  return [`Warning: existing pods in namespace "${ns}" violate the new PodSecurity enforce level "${level}:latest"`,
    ...[...groups].map(([k, ps]) => `Warning: ${ps[0]}${ps.length > 1 ? ` (and ${ps.length - 1} other pod${ps.length > 2 ? 's' : ''})` : ''}: ${k}`)];
}

function taint(c: Cluster, rest: string[], observe?: Observer): Out[] {
  const p = parse(rest, 'taint', { '--overwrite': 'bool', '--all': 'bool' });
  if (b(p, '--all')) throw new Error('error: --all is real, but this sandbox taints one node at a time');
  const t = target(p.pos, 'nodes');
  if (t.kind !== 'nodes') throw new Error(`error: invalid resource type ${t.kind}, only node types are supported`);
  const n = c.nodes.find((x) => x.name === t.name);
  if (!n) throw notFound('nodes', t.name);
  // kubectl reads a word with no =, : or trailing - as another node's name, not a taint.
  const names = t.rest.filter((x) => !/[=:]|-$/.test(x));
  if (names.length) throw new Error(t.rest.length === names.length ? 'error: at least one taint update is required' : 'error: this sandbox taints one node at a time');
  if (!t.rest.length) throw new Error('error: at least one taint update is required');
  let removed = false, added = false;
  for (const spec of t.rest) {
    // Both messages copied from kubectl 1.37.2 (taint --dry-run=client against kind v1.36.1).
    const eff = /:([^:=-]*)-?$/.exec(spec)?.[1];
    if (eff !== undefined && !['NoSchedule', 'NoExecute', 'PreferNoSchedule'].includes(eff)) throw new Error(`error: invalid taint effect: ${eff}, unsupported taint effect
See 'kubectl taint -h' for help and examples`);
    const m = /^([\w./-]*[\w.])(?:=([\w.-]*))?(?::(NoSchedule|NoExecute|PreferNoSchedule))?(-)?$/.exec(spec);
    if (!m) throw new Error(`error: invalid taint spec: ${spec}
See 'kubectl taint -h' for help and examples`);
    const [, k, v, effect, minus] = m;
    if (minus) {
      const before = n.taints.length;
      n.taints = n.taints.filter((x) => !(x.key === k && (!effect || x.effect === effect)));
      if (n.taints.length === before) throw new Error(`error: taint "${k}${effect ? `:${effect}` : ''}" not found`);
      removed = true;
      continue;
    }
    // kubectl reads key=value with no effect as a key with an = in it, and refuses the key.
    if (!effect) throw new Error(`error: invalid taint spec: ${spec}, name part must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyName',  or 'my.name',  or '123-abc', regex used for validation is '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]')
See 'kubectl taint -h' for help and examples`);
    if (n.taints.some((x) => x.key === k && x.effect === effect) && !b(p, '--overwrite')) throw new Error(`error: node ${n.name} already has ${k} taint(s) with same effect(s) and --overwrite is false`);
    n.taints = [...n.taints.filter((x) => !(x.key === k && x.effect === effect)), { key: k, ...(v !== undefined ? { value: v } : {}), effect: effect as 'NoSchedule' }];
    added = true;
  }
  observe?.({ verb: 'taint', kind: 'nodes', name: n.name });
  return say(`node/${n.name} ${added ? 'tainted' : removed ? 'untainted' : 'modified'}`);
}

// ---- rollout, delete ---------------------------------------------------

function rollout(c: Cluster, rest: string[]): Out[] {
  const [sub, ...more] = rest;
  const p = parse(more, `rollout ${sub}`, { ...NS_FLAGS, '--timeout': 'value', '--watch': 'bool', '--to-revision': 'value' });
  if (p.f['--to-revision']) throw new Error('error: --to-revision is real, but this sandbox undoes one step at a time');
  if (!p.pos.length) throw new Error(`error: required resource not specified`);
  const t = target(p.pos);
  const ns = nsOf(c, p);
  if (t.kind === 'daemonsets') {
    const ds = c.daemonsets.get(key(ns, t.name));
    if (!ds) throw notFound('daemonsets', t.name);
    if (sub === 'restart') { ds.template.annotations['kubectl.kubernetes.io/restartedAt'] = restartedAt(c); ds.generation++; return say(`daemonset.apps/${t.name} restarted`); }
    if (sub === 'status') { const st = c.dsStatus(ds); return say(st.upToDate < st.desired ? `Waiting for daemon set "${t.name}" rollout to finish: ${st.upToDate} out of ${st.desired} new pods have been updated...` : st.available < st.desired ? `Waiting for daemon set "${t.name}" rollout to finish: ${st.available} of ${st.desired} updated pods are available...` : `daemon set "${t.name}" successfully rolled out`); }
    throw new Error('error: try kubectl rollout status|restart daemonset/<name>');
  }
  if (t.kind !== 'deployments') throw new Error(`error: this sandbox rolls out deployments and daemonsets`);
  const d = c.deployment(t.name, ns);
  if (sub === 'status') {
    const st = c.deploymentStatus(t.name, ns);
    // A Deployment past its progress deadline makes rollout status fail
    // (exit 1) with this line, seen on kind v1.36.1 with progressDeadlineSeconds: 30.
    if (d.conditions.some((x) => x.type === 'Progressing' && x.reason === 'ProgressDeadlineExceeded')) throw new Error(`error: deployment "${t.name}" exceeded its progress deadline`);
    // The same three waiting messages, in the same order, as kubectl's own
    // rollout status: a stuck new pod reads "new replicas have been
    // updated", which is the line the Deployment docs show for a bad tag.
    if (st.upToDate < st.desired) return say(`Waiting for deployment "${t.name}" rollout to finish: ${st.upToDate} out of ${st.desired} new replicas have been updated...`);
    if (st.current > st.upToDate) return say(`Waiting for deployment "${t.name}" rollout to finish: ${st.current - st.upToDate} old replicas are pending termination...`);
    if (st.available < st.upToDate) return say(`Waiting for deployment "${t.name}" rollout to finish: ${st.available} of ${st.upToDate} updated replicas are available...`);
    return say(`deployment "${t.name}" successfully rolled out`);
  }
  if (sub === 'undo') {
    const prev = d.history.pop();
    if (!prev) throw new Error(`error: no rollout history found for deployment "${t.name}"`);
    d.template = prev;
    return say(`deployment.apps/${t.name} rolled back`);
  }
  if (sub === 'restart') {
    // A restart is a template change: one annotation with the time, so the
    // Deployment makes a new ReplicaSet and replaces every pod. That is also
    // how env from a ConfigMap is re-read (seen on kind v1.36.1).
    c.updateTemplate(t.name, (x) => { x.annotations['kubectl.kubernetes.io/restartedAt'] = restartedAt(c); }, ns);
    return say(`deployment.apps/${t.name} restarted`);
  }
  throw new Error('error: try kubectl rollout status|undo|restart deployment/<name>');
}

const restartedAt = (c: Cluster) => new Date(Date.UTC(2026, 10, 3, 6, 0, 0) + c.tick * SECONDS_PER_TICK * 1000).toISOString().replace('.000Z', 'Z');

function del(c: Cluster, rest: string[], observe?: Observer): Out[] {
  const p = parse(rest, 'delete', { ...NS_FLAGS, '--wait': 'bool', '--now': 'bool', '--grace-period': 'value', '--force': 'bool', '--selector': 'value', '--all': 'bool' });
  if (p.f['--grace-period'] !== undefined || b(p, '--force')) throw new Error('error: --force and --grace-period are real, but this sandbox removes pods on the next tick anyway');
  if (b(p, '--all') || s(p, '--selector')) throw new Error('error: this sandbox deletes objects by name (no --all or -l)');
  const t = target(p.pos);
  const ns = nsOf(c, p);
  if (!t.name) throw new Error('error: resource(s) were provided, but no name was specified');
  const names = [t.name, ...t.rest];
  const out: Out[] = [];
  for (const name of names) {
    const where = info(t.kind).namespaced ? ` from ${ns} namespace` : '';
    const q = `${qualified(t.kind)} "${name}" deleted${where}`;
    switch (t.kind) {
      case 'pods': {
        const pod = c.findPod(ns, name);
        if (!pod) throw notFound('pods', name);
        observe?.({ verb: 'delete', kind: 'pods', name, ns, pod });
        c.deletePod(ns, name);
        break;
      }
      case 'deployments': c.deleteDeployment(name, ns); break;
      case 'resourcequotas': if (!c.quotas.delete(key(ns, name))) throw notFound(t.kind, name); break;
      case 'configmaps': if (!c.configmaps.delete(key(ns, name))) throw notFound(t.kind, name); break;
      case 'secrets': if (!c.secrets.delete(key(ns, name))) throw notFound(t.kind, name); break;
      case 'jobs': c.deleteJob(ns, name); break;
      case 'cronjobs': {
        if (!c.cronjobs.delete(key(ns, name))) throw notFound(t.kind, name);
        for (const j of [...c.jobs.values()].filter((x) => x.ns === ns && x.owner === name)) c.deleteJob(ns, j.name);
        break;
      }
      case 'daemonsets': {
        if (!c.daemonsets.delete(key(ns, name))) throw notFound(t.kind, name);
        for (const x of c.podsOf(ns, name, 'DaemonSet')) c.deletePod(ns, x.name);
        break;
      }
      case 'namespaces': c.deleteNamespace(name); break;
      case 'replicasets': throw new Error('error: this sandbox does not let you delete a ReplicaSet its Deployment owns (it would just make another). Delete or change the Deployment.');
      case 'nodes': throw new Error('error: removing nodes is taught with the cluster operations simulator');
      default: throw new Error(`error: this sandbox cannot delete ${t.kind}`);
    }
    observe?.({ verb: 'delete', kind: t.kind, name, ns });
    out.push(...say(q));
  }
  return out;
}

// ---- config, api-resources, explain ------------------------------------

function config(c: Cluster, rest: string[], observe?: Observer): Out[] {
  const [sub, ...more] = rest;
  const p = parse(more, `config ${sub}`, { '--current': 'bool', '--namespace': 'value', '--minify': 'bool', '--output': 'value' }, { '-o': '--output' });
  switch (sub) {
    case 'current-context': return say(c.context.name);
    case 'get-contexts':
      return say(table([['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], ['*', c.context.name, c.context.name, c.context.name, c.context.namespace === 'default' ? '' : c.context.namespace]]));
    case 'set-context': {
      if (!b(p, '--current') && p.pos[0] !== c.context.name) throw new Error(`error: this sandbox has one context (${c.context.name}); use kubectl config set-context --current --namespace=<ns>`);
      const ns = s(p, '--namespace');
      if (ns === undefined) throw new Error('error: this sandbox changes only --namespace on a context');
      // Real kubectl does not check the namespace exists. A typo here makes
      // every later command look at an empty namespace, without an error.
      c.context.namespace = ns || 'default';
      observe?.({ verb: 'config', name: 'set-context', ns: c.context.namespace });
      return say(`Context "${c.context.name}" modified.`);
    }
    case 'view': {
      const out = s(p, '--output');
      if (out && out.startsWith('jsonpath=')) return say(jsonpath({ contexts: [{ context: { cluster: c.context.name, namespace: c.context.namespace, user: c.context.name }, name: c.context.name }] }, out.slice(9)));
      return say(toYaml({ apiVersion: 'v1', clusters: [{ cluster: { server: 'https://127.0.0.1:6443' }, name: c.context.name }], contexts: [{ context: { cluster: c.context.name, ...(c.context.namespace !== 'default' ? { namespace: c.context.namespace } : {}), user: c.context.name }, name: c.context.name }], 'current-context': c.context.name, kind: 'Config', users: [{ name: c.context.name, user: { 'client-certificate-data': 'DATA+OMITTED', 'client-key-data': 'DATA+OMITTED' } }] }));
    }
    case 'use-context':
      if (p.pos[0] !== c.context.name) throw new Error(`error: no context exists with the name: "${p.pos[0] ?? ''}"`);
      return say(`Switched to context "${c.context.name}".`);
  }
  throw new Error('error: this sandbox understands config current-context | get-contexts | set-context --current --namespace=<ns> | view | use-context');
}

function apiResources(rest: string[]): Out[] {
  const p = parse(rest, 'api-resources', { '--namespaced': 'value', '--api-group': 'value' });
  const ns = s(p, '--namespaced');
  const g = s(p, '--api-group');
  const rows = KIND_INFO.filter((k) => (ns === undefined || String(k.namespaced) === ns) && (g === undefined || k.group === g))
    .map((k) => [k.plural, k.short ?? '', k.group ? `${k.group}/${k.version}` : k.version, String(k.namespaced), k.kind]);
  return [...say(table([['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND'], ...rows])), ...lines('(this sandbox lists only the kinds it models; a real cluster lists many more)', 'dim')];
}

// Copied from `kubectl explain` against kind v1.36.1 (kubectl 1.37.2).
const EXPLAIN: Record<string, string> = {
  'deployment.spec.replicas': `GROUP:      apps
KIND:       Deployment
VERSION:    v1

FIELD: replicas <integer>


DESCRIPTION:
    Number of desired pods. This is a pointer to distinguish between explicit
    zero and not specified. Defaults to 1.`,
  'pod.spec.nodeselector': `KIND:       Pod
VERSION:    v1

FIELD: nodeSelector <map[string]string>


DESCRIPTION:
    NodeSelector is a selector which must be true for the pod to fit on a node.
    Selector which must match a node's labels for the pod to be scheduled on
    that node. More info:
    https://kubernetes.io/docs/concepts/configuration/assign-pod-node/`,
  'cronjob.spec.suspend': `GROUP:      batch
KIND:       CronJob
VERSION:    v1

FIELD: suspend <boolean>


DESCRIPTION:
    This flag tells the controller to suspend subsequent executions, it does not
    apply to already started executions.  Defaults to false.`,
  'pod.spec.initcontainers.restartpolicy': `KIND:       Pod
VERSION:    v1

FIELD: restartPolicy <string>


DESCRIPTION:
    RestartPolicy defines the restart behavior of individual containers in a
    pod. This overrides the pod-level restart policy. When this field is not
    specified, the restart behavior is defined by the Pod's restart policy and
    the container type. Additionally, setting the RestartPolicy as "Always" for
    the init container will have the following effect: this init container will
    be continually restarted on exit until all regular containers have
    terminated. Once all regular containers have completed, all init containers
    with restartPolicy "Always" will be shut down. This lifecycle differs from
    normal init containers and is often referred to as a "sidecar" container.
    Although this init container still starts in the init container sequence, it
    does not wait for the container to complete before proceeding to the next
    init container. Instead, the next init container starts immediately after
    this init container is started, or after any startupProbe has successfully
    completed.`,
  'configmap': `KIND:       ConfigMap
VERSION:    v1

DESCRIPTION:
    ConfigMap holds configuration data for pods to consume.

FIELDS:
  apiVersion\t<string>
  binaryData\t<map[string]string>
  data\t<map[string]string>
    Data contains the configuration data. Each key must consist of alphanumeric
    characters, '-', '_' or '.'. Values with non-UTF-8 byte sequences must use
    the BinaryData field. The keys stored in Data must not overlap with the keys
    in the BinaryData field, this is enforced during validation process.
  immutable\t<boolean>
  kind\t<string>
  metadata\t<ObjectMeta>`,
};

function explain(rest: string[]): Out[] {
  const p = parse(rest, 'explain', { '--recursive': 'bool' });
  const path = (p.pos[0] ?? '').toLowerCase().replace(/^(deployments|deploy)\./, 'deployment.').replace(/^(pods|po)\./, 'pod.').replace(/^(cronjobs|cj)\./, 'cronjob.').replace(/^(configmaps|cm)$/, 'configmap');
  if (!path) throw new Error('error: You must specify the type of resource to explain. Use "kubectl api-resources" for a complete list of supported resources.');
  const hit = EXPLAIN[path];
  if (hit) return say(hit);
  if (path === 'deployment.spec.nonsense') throw new Error('GROUP:      apps\nKIND:       Deployment\nVERSION:    v1\n\nerror: field "nonsense" does not exist');
  throw new Error(`error: this sandbox carries the real text for only a few paths: ${Object.keys(EXPLAIN).join(', ')}. Run kubectl explain on a real cluster for the rest.`);
}

export { templateHash, type Deployment };
