// The terminal for the networking sandbox: a subset of kubectl, plus curl and
// nslookup run inside a pod with `kubectl exec`, and curl from your own machine.
// Every message below was copied from a real run (Kubernetes 1.36.1 on kind
// with kindnet, kubectl 1.37.2, curl 8.11.1 from curlimages/curl, busybox
// 1.36.1's nslookup); tests/kube-net.test.ts pins each one and says which.
// Anything it can't do, it refuses by name: a flag it doesn't know is an
// error here, never silently ignored.

import { Net, IMAGES, NODES, DNS_IP, selectorText, suffix, type Pod, type Service, type Labels, type SvcPort, type Attempt } from './net.ts';
import { applyManifest } from './manifests.ts';

export type Out = { text: string; kind: 'out' | 'err' };
export type Event =
  | { type: 'cmd'; verb: string; kind?: string; name?: string; ns: string; line: string }
  | { type: 'curl'; from: string; url: string; attempt: Attempt; host: boolean; enforcing: boolean; dnsReplicas: number; policies: number }
  | { type: 'lookup'; from: string; name: string; found: boolean; how?: string; ips: string[]; corednsReplicas: number }
  | { type: 'apply'; kind: string; name: string; ns: string; result: 'created' | 'configured' | 'unchanged' | 'error' };

export type Files = Record<string, string>;
export type Ctx = { net: Net; files: Files; ns: string; events: Event[] };

/** What the world looked like when a request was made, so missions can judge it later. */
const snap = (net: Net) => ({ enforcing: net.enforcing, dnsReplicas: net.corednsReplicas, policies: net.policies.size });

class CmdError extends Error {}
function fail(m: string): never { throw new CmdError(m); }

/** Shell words with quotes, refusing the shell features this terminal doesn't have. */
export function words(line: string): string[] {
  const out: string[] = [];
  let cur = '', q: string | null = null, had = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && /["\\$`]/.test(line[i + 1] ?? '')) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; had = true; continue; }
    if (c === ' ' || c === '\t') { if (cur || had) out.push(cur); cur = ''; had = false; continue; }
    if (c === '|') fail('This terminal has no pipes (|). Run the command on its own; grep, head and wc are not here.');
    if (c === '>' || c === '<') fail('This terminal has no redirection (> or <). Edit files in the editor above instead.');
    if (c === ';' || (c === '&' && line[i + 1] === '&')) fail('Run one command at a time here (no ; or &&).');
    if (c === '$' && /[({A-Za-z_]/.test(line[i + 1] ?? '')) fail('This terminal has no shell variables or $(...). Type the value itself.');
    if (c === '\\' && i === line.length - 1) fail('Put the whole command on one line here.');
    cur += c;
  }
  if (q) fail(`unexpected EOF while looking for matching \`${q}'`);
  if (cur || had) out.push(cur);
  return out;
}

const KINDS: Record<string, string> = {
  po: 'pods', pod: 'pods', pods: 'pods',
  svc: 'services', service: 'services', services: 'services',
  deploy: 'deployments', deployment: 'deployments', deployments: 'deployments',
  endpointslice: 'endpointslices', endpointslices: 'endpointslices',
  ep: 'endpoints', endpoints: 'endpoints',
  netpol: 'networkpolicies', networkpolicy: 'networkpolicies', networkpolicies: 'networkpolicies',
  ing: 'ingresses', ingress: 'ingresses', ingresses: 'ingresses',
  ingressclass: 'ingressclasses', ingressclasses: 'ingressclasses',
  ns: 'namespaces', namespace: 'namespaces', namespaces: 'namespaces',
  no: 'nodes', node: 'nodes', nodes: 'nodes',
};
// The API group each modelled kind lives in, so `deployments.apps` and
// `netpol.networking.k8s.io` work as they do for real.
const GROUPS: Record<string, string> = { deployments: 'apps', endpointslices: 'discovery.k8s.io', networkpolicies: 'networking.k8s.io', ingresses: 'networking.k8s.io', ingressclasses: 'networking.k8s.io' };
// Resource names a real 1.36 cluster serves that this sandbox doesn't model.
// They must not get the server's "doesn't have a resource type" error: an
// earlier version said that for `get all`, `rs` and `events`, which told
// learners those things don't exist in Kubernetes.
const UNMODELLED = new Set(('all rs replicaset replicasets ev event events cm configmap configmaps secret secrets sa serviceaccount serviceaccounts ' +
  'sts statefulset statefulsets ds daemonset daemonsets job jobs cj cronjob cronjobs pv persistentvolume persistentvolumes pvc persistentvolumeclaim persistentvolumeclaims ' +
  'crd crds customresourcedefinition customresourcedefinitions role roles rolebinding rolebindings clusterrole clusterroles clusterrolebinding clusterrolebindings ' +
  'hpa horizontalpodautoscaler horizontalpodautoscalers pdb poddisruptionbudget poddisruptionbudgets quota resourcequota resourcequotas limits limitrange limitranges ' +
  'sc storageclass storageclasses cs componentstatus componentstatuses csr certificatesigningrequest certificatesigningrequests lease leases pc priorityclass priorityclasses ' +
  'rc replicationcontroller replicationcontrollers podtemplate podtemplates controllerrevision controllerrevisions apiservice apiservices runtimeclass runtimeclasses ' +
  'mutatingwebhookconfiguration mutatingwebhookconfigurations validatingwebhookconfiguration validatingwebhookconfigurations csidriver csidrivers csinode csinodes ' +
  'volumeattachment volumeattachments flowschema flowschemas prioritylevelconfiguration prioritylevelconfigurations ipaddress ipaddresses servicecidr servicecidrs').split(' '));
const MODELLED = 'pods, services, deployments, endpointslices, endpoints, networkpolicies, ingresses, ingressclasses, namespaces and nodes';

/** A resource name as typed, to the kind this sandbox calls it; null for a name no Kubernetes serves. */
function kindOf(arg: string): string | null {
  const dot = arg.indexOf('.');
  const base = (dot < 0 ? arg : arg.slice(0, dot)).toLowerCase();
  const group = dot < 0 ? null : arg.slice(dot + 1);
  const kind = KINDS[base];
  if (kind && (group === null || GROUPS[kind] === group)) return kind;
  if (UNMODELLED.has(base)) fail(`This sandbox doesn't model ${arg}. A real cluster has it; this one holds only ${MODELLED}.`);
  if (group !== null) fail(`This sandbox doesn't model ${arg}. It holds only ${MODELLED}, and none of its CRDs are installed.`);
  return null;
}

// Real kubectl commands this sandbox doesn't have. Anything else gets kubectl's
// own "unknown command", which is then true.
const REAL_COMMANDS = new Set(['autoscale', 'certificate', 'cluster-info', 'top', 'cordon', 'uncordon', 'drain', 'taint', 'attach', 'proxy', 'auth', 'events', 'diff', 'replace', 'wait', 'kustomize', 'completion', 'alpha', 'api-resources', 'api-versions', 'config', 'plugin', 'version', 'options']);

// The group-qualified names kubectl prints in "created" and "deleted" lines.
const QUALIFIED: Record<string, [string, string]> = {
  pods: ['pod', 'pods'], services: ['service', 'services'], deployments: ['deployment.apps', 'deployments.apps'],
  networkpolicies: ['networkpolicy.networking.k8s.io', 'networkpolicies.networking.k8s.io'],
  ingresses: ['ingress.networking.k8s.io', 'ingresses.networking.k8s.io'],
  ingressclasses: ['ingressclass.networking.k8s.io', 'ingressclasses.networking.k8s.io'],
  namespaces: ['namespace', 'namespaces'],
};
const notFound = (kind: string, name: string) => `Error from server (NotFound): ${kind === 'deployments' ? 'deployments.apps' : QUALIFIED[kind]?.[1] ?? kind} "${name}" not found`;

type Parsed = { pos: string[]; flags: Map<string, string | true>; after?: string[] };

/** Splits args into positionals and flags, refusing any flag the command doesn't list. */
function parseArgs(args: string[], allowed: Record<string, 'value' | 'bool'>, cmd: string): Parsed {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return { pos, flags, after: args.slice(i + 1) };
    if (!a.startsWith('-') || a === '-') { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    const kind = allowed[name];
    if (!kind) fail(`error: unknown flag: ${name}\nSee 'kubectl ${cmd} --help' for usage. (This sandbox supports: ${Object.keys(allowed).join(' ') || 'no flags'}.)`);
    if (kind === 'bool') { flags.set(name, true); continue; }
    const v = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (v === undefined) fail(`error: flag needs an argument: ${name}`);
    flags.set(name, v);
  }
  return { pos, flags };
}

const NS_FLAGS = { '-n': 'value', '--namespace': 'value' } as const;
const nsOf = (ctx: Ctx, p: Parsed) => String(p.flags.get('-n') ?? p.flags.get('--namespace') ?? ctx.ns);

function age(net: Net, since: number) {
  const s = Math.max(0, net.t - since);
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 10 ? `${m}m${s % 60}s` : `${m}m`;
}

/** kubectl's column layout: each column padded to its widest cell plus three spaces. */
export function table(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i] + 3))).join('').trimEnd()).join('\n');
}

// kubectl prints labels sorted by key (measured with --show-labels).
const labelText = (l: Labels) => Object.keys(l).sort().map((k) => `${k}=${l[k]}`).join(',') || '<none>';
/** The labels on a Service's EndpointSlice, as 1.36.1 writes them. */
const sliceLabels = (s: Service): Labels => (s.staticEndpoints
  ? { 'kubernetes.io/service-name': s.name }
  : { ...s.labels, 'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io', 'kubernetes.io/service-name': s.name });
const sliceName = (s: Service) => (s.staticEndpoints ? s.name : `${s.name}-${suffix(s.ns + s.name, 5)}`);
const portsText = (s: Service) => s.ports.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol}`).join(',');

export const HELP = `This terminal is your machine, with kubectl pointed at a two-node kind cluster.
kubectl get pods|svc|deploy|endpointslices|endpoints|netpol|ingress|ingressclass|ns|nodes  [-n NS | -A] [-o wide] [--show-labels] [-l k=v]
kubectl describe svc|ingress|netpol NAME
kubectl create deployment NAME --image=IMAGE [--replicas=N]      kubectl create namespace NAME
kubectl expose deployment NAME --port=N [--target-port=N] [--type=NodePort|LoadBalancer] [--cluster-ip=None] [--name=SVC]
kubectl create ingress NAME --rule='HOST/PATH=SVC:PORT' [--class=CLASS]
kubectl patch svc|ingress NAME -p '{"spec":{...}}'       kubectl set selector svc NAME 'app=x'
kubectl scale deployment NAME --replicas=N               kubectl label ns|pod NAME key=value  (key- removes)
kubectl apply -f FILE    (files are the tabs in the editor)      kubectl delete KIND NAME
kubectl exec [-n NS] POD -- curl [-sS] [-m SECONDS] [-o /dev/null -w '%{http_code}\\n'] [-X POST] URL
kubectl exec [-n NS] POD -- nslookup NAME          kubectl exec [-n NS] POD -- cat /etc/resolv.conf
curl URL     from your machine: a node's IP and NodePort, or http://NAME.localhost through an Ingress controller
Images: ${Object.keys(IMAGES).filter((i) => i.startsWith('panda/')).join('  ')}`;

export function run(ctx: Ctx, line: string): Out[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  ctx.net.tick();
  try {
    const argv = words(trimmed);
    if (argv[0] === 'help' || (argv[0] === 'kubectl' && argv.length === 1)) return out(HELP);
    if (argv[0] === 'curl') return hostCurl(ctx, argv.slice(1));
    if (argv[0] === 'nslookup' || argv[0] === 'dig') fail(`${argv[0]} here would ask your machine's DNS, which knows nothing about the cluster. Run it in a pod: kubectl exec client -- nslookup NAME`);
    if (argv[0] !== 'kubectl' && argv[0] !== 'k') fail(`${argv[0]}: command not found (this terminal has kubectl and curl - type help)`);
    return kubectl(ctx, argv.slice(1), trimmed);
  } catch (e) {
    if (e instanceof CmdError) return out(e.message, 'err');
    // Anything else is a bug in this sandbox, not in the learner's command.
    return out(`A bug in the sandbox, not in your command: ${(e as Error).message}. Start over to reset the cluster.`, 'err');
  }
}

function out(text: string, kind: Out['kind'] = 'out'): Out[] {
  return text.split('\n').map((t) => ({ text: t, kind }));
}

function kubectl(ctx: Ctx, args: string[], line: string): Out[] {
  // Global -n before the verb, as in `kubectl -n shop get pods`.
  let ns: string | undefined;
  while (args[0] === '-n' || args[0] === '--namespace' || args[0]?.startsWith('--namespace=') || args[0] === '-A') {
    if (args[0] === '-A') break;
    if (args[0].startsWith('--namespace=')) { ns = args[0].slice(12); args = args.slice(1); }
    else { ns = args[1]; args = args.slice(2); }
    if (!ns) fail('error: flag needs an argument: \'n\' in -n');
  }
  // Move it among the command's own flags: before any "--", so it is never
  // taken as part of the command run in a pod.
  if (ns && args.length) {
    const dd = args.indexOf('--');
    args = dd < 0 ? [...args, '-n', ns] : [...args.slice(0, dd), '-n', ns, ...args.slice(dd)];
  }
  const [verb, ...rest] = args;
  const record = (kind?: string, name?: string, n?: string) => ctx.events.push({ type: 'cmd', verb, kind, name, ns: n ?? ctx.ns, line });
  switch (verb) {
    case 'get': return get(ctx, rest, record);
    case 'describe': return describe(ctx, rest, record);
    case 'create': return create(ctx, rest, record);
    case 'expose': return expose(ctx, rest, record);
    case 'patch': return patch(ctx, rest, record);
    case 'set': return setSelector(ctx, rest, record);
    case 'scale': return scale(ctx, rest, record);
    case 'label': return label(ctx, rest, record);
    case 'delete': return del(ctx, rest, record);
    case 'apply': return apply(ctx, rest, record);
    case 'exec': return exec(ctx, rest, record);
    case 'run': return fail('kubectl run is not in this sandbox. A client pod is already running: use kubectl exec client -- ...');
    case 'edit': case 'port-forward': case 'logs': case 'explain': case 'rollout': case 'annotate': case 'cp': case 'debug':
      return fail(`kubectl ${verb} is not in this sandbox. Type help for what is.`);
    default:
      if (REAL_COMMANDS.has(verb ?? '')) return fail(`kubectl ${verb} is not in this sandbox (a real kubectl has it). Type help for what is.`);
      return fail(`error: unknown command "${verb ?? ''}" for "kubectl"`);
  }
}

// ---- get --------------------------------------------------------------------

function get(ctx: Ctx, args: string[], record: (k?: string, n?: string, ns?: string) => void): Out[] {
  const p = parseArgs(args, { ...NS_FLAGS, '-A': 'bool', '--all-namespaces': 'bool', '-o': 'value', '--output': 'value', '--show-labels': 'bool', '-l': 'value', '--selector': 'value' }, 'get');
  const all = p.flags.has('-A') || p.flags.has('--all-namespaces');
  const ns = nsOf(ctx, p);
  const o = String(p.flags.get('-o') ?? p.flags.get('--output') ?? '');
  if (o && o !== 'wide') fail(`error: this sandbox prints tables only (-o wide), not -o ${o}`);
  const wide = o === 'wide';
  let [kindArg, name] = p.pos;
  if (kindArg?.includes('/')) [kindArg, name] = kindArg.split('/');
  if (!kindArg) fail('You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.');
  if (kindArg.includes(',')) fail('error: this sandbox gets one kind at a time (no comma lists)');
  const kind = kindOf(kindArg);
  if (!kind) fail(`error: the server doesn't have a resource type "${kindArg}"`);
  const sel = p.flags.get('-l') ?? p.flags.get('--selector');
  const want: Labels = {};
  if (sel) for (const part of String(sel).split(',')) {
    const m = /^([\w./-]+)=([\w.-]*)$/.exec(part);
    if (!m) fail(`error: this sandbox's -l takes key=value pairs, not "${part}"`);
    want[m[1]] = m[2];
  }
  const showLabels = p.flags.has('--show-labels');
  // Kinds whose labels this sandbox doesn't keep refuse -l and --show-labels
  // by name. An earlier version ignored them, so `get endpointslices
  // -l app=nothing` listed every slice.
  const labelled = ['pods', 'namespaces', 'services', 'endpointslices', 'deployments'];
  if (sel && !labelled.includes(kind)) fail(`error: this sandbox doesn't keep labels on ${kind}, so it can't filter them with -l. It can for pods, namespaces, services, endpointslices and deployments.`);
  if (showLabels && !['pods', 'namespaces', 'services', 'endpointslices'].includes(kind)) fail(`error: this sandbox shows --show-labels for pods, namespaces, services and endpointslices, not ${kind}.`);
  record(kind, name, ns);
  const net = ctx.net;
  // The API server lists objects in key order: by namespace, then name.
  const order = <T extends { ns: string; name: string }>(xs: T[]) => [...xs].sort((a, b) => (a.ns === b.ns ? (a.name < b.name ? -1 : 1) : a.ns < b.ns ? -1 : 1));
  const inNs = <T extends { ns: string; name: string }>(xs: T[]) => order(xs.filter((x) => all || x.ns === ns));
  const byName = <T extends { name: string }>(xs: T[]) => (name ? xs.filter((x) => x.name === name) : xs);
  const matches = (l: Labels) => Object.entries(want).every(([k, v]) => l[k] === v);
  const empty = () => (all ? 'No resources found' : `No resources found in ${ns} namespace.`);
  const nsCol = (r: string[], n: string) => (all ? [n, ...r] : r);
  const head = (h: string[]) => (all ? ['NAMESPACE', ...h] : h);

  if (kind === 'nodes') {
    const rows = NODES.map((n) => [n.name, 'Ready', n.name.includes('control') ? 'control-plane' : '<none>', '20m', 'v1.36.1', ...(wide ? [n.ip, '<none>'] : [])]);
    return out(table([['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION', ...(wide ? ['INTERNAL-IP', 'EXTERNAL-IP'] : [])], ...rows]));
  }
  if (kind === 'namespaces') {
    const rows = [...net.namespaces.entries()].filter(([n, v]) => (!name || n === name) && matches(v.labels)).map(([n, v]) => [n, 'Active', age(net, v.created - 1200), ...(showLabels ? [labelText(v.labels)] : [])]);
    if (name && !rows.length) fail(notFound('namespaces', name));
    return out(table([['NAME', 'STATUS', 'AGE', ...(showLabels ? ['LABELS'] : [])], ...rows]));
  }
  if (kind === 'ingressclasses') {
    const rows = byName([...net.classes.values()]).map((c) => [c.name, c.controller, '<none>', age(net, c.created)]);
    if (name && !rows.length) fail(notFound(kind, name));
    if (!rows.length) return out('No resources found');
    return out(table([['NAME', 'CONTROLLER', 'PARAMETERS', 'AGE'], ...rows]));
  }
  if (kind === 'pods') {
    const pods = byName(inNs(net.podsIn())).filter((x) => matches(x.labels));
    if (name && !pods.length) fail(notFound(kind, name));
    if (!pods.length) return out(empty());
    const rows = pods.map((x) => nsCol([x.name, x.ready ? '1/1' : '0/1', 'Running', '0', age(net, x.created), ...(wide ? [x.ip, x.node, '<none>', '<none>'] : []), ...(showLabels ? [labelText(x.labels)] : [])], x.ns));
    return out(table([head(['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : []), ...(showLabels ? ['LABELS'] : [])]), ...rows]));
  }
  if (kind === 'deployments') {
    const ds = byName(inNs([...net.deployments.values()])).filter((d) => matches(d.labels));
    if (name && !ds.length) fail(notFound(kind, name));
    if (!ds.length) return out(empty());
    const rows = ds.map((d) => {
      const pods = net.podsIn(d.ns).filter((x) => x.owner === d.name);
      const ready = pods.filter((x) => x.ready).length;
      return nsCol([d.name, `${ready}/${d.replicas}`, String(pods.length), String(ready), age(net, d.created), ...(wide ? ['app', d.image, `app=${d.name}`] : [])], d.ns);
    });
    return out(table([head(['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])]), ...rows]));
  }
  if (kind === 'services') {
    const ss = byName(inNs([...net.services.values()])).filter((s) => matches(s.labels));
    if (name && !ss.length) fail(notFound(kind, name));
    if (!ss.length) return out(empty());
    net.syncLoadBalancers();
    const rows = ss.map((s) => nsCol([s.name, s.type, s.clusterIP, s.type === 'LoadBalancer' ? s.externalIP ?? '<pending>' : '<none>', portsText(s), age(net, s.created), ...(wide ? [s.selector ? labelText(s.selector) : '<none>'] : []), ...(showLabels ? [labelText(s.labels)] : [])], s.ns));
    return out(table([head(['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE', ...(wide ? ['SELECTOR'] : []), ...(showLabels ? ['LABELS'] : [])]), ...rows]));
  }
  if (kind === 'endpointslices') {
    const ss = inNs([...net.services.values()]).filter((s) => (s.selector || s.staticEndpoints) && matches(sliceLabels(s)));
    const rows = ss.map((s) => {
      if (s.staticEndpoints) return nsCol([sliceName(s), 'IPv4', s.staticEndpoints.map((e) => e.port).join(','), s.staticEndpoints.map((e) => e.ip).join(','), age(net, s.created), ...(showLabels ? [labelText(sliceLabels(s))] : [])], s.ns);
      const eps = net.endpoints(s);
      // One entry per Service port, repeats kept: tilt's kube-dns slice reads "53,53,9153".
      const sp = s.ports.map((p) => (eps[0] ? net.targetOn(p, eps[0].pod) : null)).filter((x): x is number => x !== null);
      // kubectl lists every address in the slice, ready or not; readiness is a
      // condition on each endpoint. Measured: an unready pod still appears here.
      return nsCol([sliceName(s), 'IPv4', eps.length && sp.length ? sp.join(',') : '<unset>', eps.length ? eps.map((e) => e.pod.ip).join(',') : '<unset>', age(net, s.created), ...(showLabels ? [labelText(sliceLabels(s))] : [])], s.ns);
    }).filter((r) => !name || r[all ? 1 : 0] === name);
    if (name && !rows.length) fail(notFound(kind, name));
    if (!rows.length) return out(empty());
    return out(table([head(['NAME', 'ADDRESSTYPE', 'PORTS', 'ENDPOINTS', 'AGE', ...(showLabels ? ['LABELS'] : [])]), ...rows]));
  }
  if (kind === 'endpoints') {
    const ss = byName(inNs([...net.services.values()]));
    if (name && !ss.length) fail(notFound(kind, name));
    const warn = { text: 'Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice', kind: 'err' as const };
    if (!ss.length) return [warn, ...out(empty())];
    const rows = ss.map((s) => nsCol([s.name, readyEndpoints(net, s) || '<none>', age(net, s.created)], s.ns));
    return [warn, ...out(table([head(['NAME', 'ENDPOINTS', 'AGE']), ...rows]))];
  }
  if (kind === 'networkpolicies') {
    const ps = byName(inNs([...net.policies.values()]));
    if (name && !ps.length) fail(notFound(kind, name));
    if (!ps.length) return out(empty());
    return out(table([head(['NAME', 'POD-SELECTOR', 'AGE']), ...ps.map((x) => nsCol([x.name, selectorText(x.podSelector), age(net, x.created)], x.ns))]));
  }
  if (kind === 'ingresses') {
    const is = byName(inNs([...net.ingresses.values()]));
    if (name && !is.length) fail(notFound(kind, name));
    if (!is.length) return out(empty());
    return out(table([head(['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE']), ...is.map((i) => nsCol([i.name, i.className ?? '<none>', i.rules.map((r) => r.host ?? '*').join(',') || '*', i.address, i.tls.length ? '80, 443' : '80', age(net, i.created)], i.ns))]));
  }
  return fail(`error: this sandbox can't get ${kind}`);
}

/** The ready endpoints, as "ip:port,ip:port" - what describe svc and get endpoints show. */
function readyEndpoints(net: Net, s: Service) {
  if (s.staticEndpoints) return s.staticEndpoints.map((e) => `${e.ip}:${e.port}`).join(',');
  const parts: string[] = [];
  for (const e of net.endpoints(s).filter((x) => x.ready)) for (const sp of s.ports) { const t = net.targetOn(sp, e.pod); if (t !== null) parts.push(`${e.pod.ip}:${t}`); }
  return [...new Set(parts)].join(',');
}

// ---- describe ---------------------------------------------------------------

function describe(ctx: Ctx, args: string[], record: (k?: string, n?: string, ns?: string) => void): Out[] {
  const p = parseArgs(args, { ...NS_FLAGS }, 'describe');
  const ns = nsOf(ctx, p);
  let [kindArg, name] = p.pos;
  if (kindArg?.includes('/')) [kindArg, name] = kindArg.split('/');
  const kind = kindArg ? kindOf(kindArg) : null;
  if (!kind) fail(kindArg ? `error: the server doesn't have a resource type "${kindArg}"` : 'You must specify the type of resource to describe.');
  if (!name) fail(`error: this sandbox describes one ${kindArg} at a time: kubectl describe ${kindArg} NAME`);
  record(kind, name, ns);
  const net = ctx.net;
  const pad = (k: string, w: number) => (k + ':').padEnd(w);
  if (kind === 'services') {
    const s = net.service(ns, name) ?? fail(notFound(kind, name));
    const w = 26;
    const lines = [
      `${pad('Name', w)}${s.name}`, `${pad('Namespace', w)}${s.ns}`, `${pad('Labels', w)}${labelText(s.labels)}`, `${pad('Annotations', w)}<none>`,
      `${pad('Selector', w)}${s.selector ? labelText(s.selector) : ''}`, `${pad('Type', w)}${s.type}`, `${pad('IP Family Policy', w)}SingleStack`, `${pad('IP Families', w)}IPv4`,
      `${pad('IP', w)}${s.clusterIP}`, `${pad('IPs', w)}${s.clusterIP}`,
    ];
    for (const sp of s.ports) {
      lines.push(`${pad('Port', w)}${sp.name ?? '<unset>'}  ${sp.port}/${sp.protocol}`, `${pad('TargetPort', w)}${sp.targetPort}/${sp.protocol}`);
      if (sp.nodePort) lines.push(`${pad('NodePort', w)}${sp.name ?? '<unset>'}  ${sp.nodePort}/${sp.protocol}`);
    }
    lines.push(`${pad('Endpoints', w)}${readyEndpoints(net, s)}`, `${pad('Session Affinity', w)}None`);
    if (s.type !== 'ClusterIP') lines.push(`${pad('External Traffic Policy', w)}Cluster`);
    lines.push(`${pad('Internal Traffic Policy', w)}Cluster`, `${pad('Events', w)}<none>`);
    return out(lines.map((l) => l.trimEnd()).join('\n'));
  }
  if (kind === 'ingresses') {
    const i = net.ingresses.get(`${ns}/${name}`) ?? fail(notFound(kind, name));
    const w = 18;
    const lines = [`${pad('Name', w)}${i.name}`, `${pad('Labels', w)}<none>`, `${pad('Namespace', w)}${i.ns}`, `${pad('Address', w)}${i.address}`, `${pad('Ingress Class', w)}${i.className ?? '<none>'}`, `${pad('Default backend', w)}<default>`];
    if (i.tls.length) {
      lines.push('TLS:');
      for (const t of i.tls) lines.push(`  ${t.secretName ?? 'SNI routes'} terminates ${t.hosts.join(',')}`);
    }
    // The rules table shares one tab stop with the lines after it, so its width
    // (the longest host plus two) also pads Annotations and Events. Measured:
    // 13-character hosts gave 15, 14-character hosts 16 (kubectl 1.37.2).
    const hw = Math.max(4, ...i.rules.map((r) => (r.host ?? '*').length)) + 2;
    lines.push('Rules:', `  ${'Host'.padEnd(hw)}Path  Backends`, `  ${'----'.padEnd(hw)}----  --------`);
    for (const r of i.rules) {
      lines.push(`  ${(r.host ?? '*').padEnd(hw)}`);
      for (const pth of r.paths) {
        const s = net.service(i.ns, pth.service);
        const eps = s ? readyEndpoints(net, s) : '';
        lines.push(`  ${''.padEnd(hw)}${pth.path.padEnd(4)}${pth.service}:${pth.port} (${s ? eps || '<none>' : `<error: services "${pth.service}" not found>`})`);
      }
    }
    lines.push(`${pad('Annotations', hw + 2)}<none>`, `${pad('Events', hw + 2)}<none>`);
    return out(lines.join('\n'));
  }
  if (kind === 'networkpolicies') {
    const pol = net.policies.get(`${ns}/${name}`) ?? fail(notFound(kind, name));
    const lines = [`Name:         ${pol.name}`, `Namespace:    ${pol.ns}`, `Created on:   (in this sandbox, ${age(net, pol.created)} ago)`, 'Labels:       <none>', 'Annotations:  <none>', 'Spec:'];
    const sel = selectorText(pol.podSelector);
    lines.push(`  PodSelector:     ${sel === '<none>' ? '<none> (Allowing the specific traffic to all pods in this namespace)' : sel}`);
    const peerLines = (peers: typeof pol.ingress[0]['peers'], word: 'From' | 'To') => {
      if (peers === null) return [`    ${word}: <any> (traffic not restricted by ${word === 'From' ? 'source' : 'destination'})`];
      // One "From:" per peer, as kubectl 1.37 prints it: that is how describe
      // tells two peers (either one) from one peer with two selectors (both).
      const ls: string[] = [];
      for (const pr of peers) {
        ls.push(`    ${word}:`);
        if (pr.ipBlock) { ls.push('      IPBlock:', `        CIDR: ${pr.ipBlock.cidr}`, `        Except: ${(pr.ipBlock.except ?? []).join(', ')}`); continue; }
        if (pr.namespaceSelector) ls.push(`      NamespaceSelector: ${selectorText(pr.namespaceSelector)}`);
        if (pr.podSelector) ls.push(`      PodSelector: ${selectorText(pr.podSelector)}`);
      }
      return ls;
    };
    const portLines = (ports: typeof pol.ingress[0]['ports']) => (ports === null ? ['    To Port: <any> (traffic allowed to all ports)'] : ports.map((pp) => `    To Port: ${pp.port ?? '<any>'}/${pp.protocol}`));
    for (const [dir, rules, word] of [['Ingress', pol.ingress, 'From'], ['Egress', pol.egress, 'To']] as const) {
      const verb = dir === 'Ingress' ? 'ingress' : 'egress';
      if (!pol.types.includes(dir)) { lines.push(`  Not affecting ${verb} traffic`); continue; }
      if (!rules.length) { lines.push(`  Allowing ${verb} traffic:`, `    <none> (Selected pods are isolated for ${verb} connectivity)`); continue; }
      lines.push(`  Allowing ${verb} traffic:`);
      rules.forEach((r, i) => { if (i) lines.push('    ----------'); lines.push(...portLines(r.ports), ...peerLines(r.peers, word)); });
    }
    lines.push(`  Policy Types: ${pol.types.join(', ')}`);
    return out(lines.join('\n'));
  }
  return fail(`error: this sandbox describes services, ingresses and networkpolicies; for ${kind}, use kubectl get ${kindArg} -o wide`);
}

// ---- create, expose, patch, set, scale, label, delete ------------------------

const IMAGE_LIST = () => Object.keys(IMAGES).filter((i) => i.startsWith('panda/')).join(', ');

function create(ctx: Ctx, args: string[], record: (k?: string, n?: string, ns?: string) => void): Out[] {
  const [what, ...rest] = args;
  const net = ctx.net;
  if (what === 'deployment' || what === 'deploy') {
    const p = parseArgs(rest, { ...NS_FLAGS, '--image': 'value', '--replicas': 'value', '-r': 'value', '--port': 'value' }, 'create deployment');
    const ns = nsOf(ctx, p);
    const name = p.pos[0] ?? fail('error: exactly one NAME is required, got 0');
    const image = p.flags.get('--image');
    if (!image) fail('error: required flag(s) "image" not set');
    if (!IMAGES[String(image)] || !String(image).startsWith('panda/')) fail(`error: this sandbox runs only its own images: ${IMAGE_LIST()}`);
    const r = Number(p.flags.get('--replicas') ?? p.flags.get('-r') ?? 1);
    if (!Number.isInteger(r) || r < 0 || r > 6) fail('error: this sandbox runs 0 to 6 replicas');
    const port = p.flags.get('--port');
    if (port !== undefined && Number(port) !== IMAGES[String(image)].listen) fail(`error: ${image} listens on ${IMAGES[String(image)].listen}; this sandbox does not let --port claim otherwise`);
    if (!net.namespaces.has(ns)) fail(`error: failed to create deployment: namespaces "${ns}" not found`);
    if (net.deployments.has(`${ns}/${name}`)) fail(`error: failed to create deployment: deployments.apps "${name}" already exists`);
    net.createDeployment(ns, name, String(image), r);
    record('deployments', name, ns);
    return out(`deployment.apps/${name} created`);
  }
  if (what === 'namespace' || what === 'ns') {
    const p = parseArgs(rest, {}, 'create namespace');
    const name = p.pos[0] ?? fail('error: exactly one NAME is required, got 0');
    if (net.namespaces.has(name)) fail(`Error from server (AlreadyExists): namespaces "${name}" already exists`);
    net.addNamespace(name);
    record('namespaces', name, name);
    return out(`namespace/${name} created`);
  }
  if (what === 'ingress' || what === 'ing') {
    const p = parseArgs(rest, { ...NS_FLAGS, '--rule': 'value', '--class': 'value' }, 'create ingress');
    const ns = nsOf(ctx, p);
    const name = p.pos[0] ?? fail('error: exactly one NAME is required, got 0');
    const rule = p.flags.get('--rule');
    if (!rule) fail('error: this sandbox needs at least one --rule=HOST/PATH=SVC:PORT');
    // Real message for a malformed rule, kubectl 1.37.2.
    const m = /^([^/=]*)\/([^=]*)=([^:,]+):(\d+|[a-z][-a-z0-9]*)(,tls(=([^,]+))?)?$/.exec(String(rule));
    if (!m) fail(`error: rule ${rule} is invalid and should be in format host/path=svcname:svcport[,tls[=secret]]`);
    const [, host, rawPath, svc, port, tls, , secret] = m!;
    const exact = !rawPath.endsWith('*');
    const path = '/' + rawPath.replace(/\*$/, '');
    if (net.ingresses.has(`${ns}/${name}`)) fail(`error: failed to create ingress: ingresses.networking.k8s.io "${name}" already exists`);
    const className = p.flags.has('--class') ? String(p.flags.get('--class')) : defaultClass(net);
    net.ingresses.set(`${ns}/${name}`, {
      name, ns, className, created: net.t, address: '', raw: null,
      rules: [{ host: host || undefined, paths: [{ path, pathType: exact ? 'Exact' : 'Prefix', service: svc, port: /^\d+$/.test(port) ? Number(port) : port }] }],
      tls: tls ? [{ hosts: host ? [host] : [], secretName: secret }] : [],
    });
    syncIngress(net);
    record('ingresses', name, ns);
    return out(`ingress.networking.k8s.io/${name} created`);
  }
  if (what === 'service' || what === 'svc') fail('kubectl create service is not in this sandbox; use kubectl expose deployment NAME --port=N --target-port=N');
  return fail(`error: this sandbox creates deployment, namespace and ingress; not "${what ?? ''}"`);
}

/** What the DefaultIngressClass admission plugin fills in on a new Ingress with no class. */
export function defaultClass(net: Net): string | null {
  const d = [...net.classes.values()].filter((c) => c.isDefault);
  return d.length === 1 ? d[0].name : null;
}

/** The toy controller claims Ingresses of its class and writes their address. */
export function syncIngress(net: Net) {
  for (const i of net.ingresses.values()) i.address = net.ingressController && i.className === net.ingressController.className ? 'localhost' : '';
}

function expose(ctx: Ctx, args: string[], record: (k?: string, n?: string, ns?: string) => void): Out[] {
  const p = parseArgs(args, { ...NS_FLAGS, '--port': 'value', '--target-port': 'value', '--type': 'value', '--name': 'value', '--cluster-ip': 'value', '--protocol': 'value' }, 'expose');
  const ns = nsOf(ctx, p);
  let [kindArg, name] = p.pos;
  if (kindArg?.includes('/')) [kindArg, name] = kindArg.split('/');
  if (KINDS[kindArg ?? ''] !== 'deployments') fail('error: this sandbox exposes deployments: kubectl expose deployment NAME --port=N');
  const d = ctx.net.deployments.get(`${ns}/${name}`) ?? fail(notFound('deployments', name ?? ''));
  const port = Number(p.flags.get('--port'));
  if (!p.flags.has('--port')) fail("error: couldn't find port via --port flag or introspection\nSee 'kubectl expose -h' for help and examples");
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`error: invalid port "${p.flags.get('--port')}"`);
  const tpRaw = p.flags.get('--target-port');
  const tp: number | string = tpRaw === undefined ? port : /^\d+$/.test(String(tpRaw)) ? Number(tpRaw) : String(tpRaw);
  const typeRaw = String(p.flags.get('--type') ?? 'ClusterIP');
  const type = ({ clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer' } as const)[typeRaw.toLowerCase() as 'clusterip'];
  if (!type) fail(`error: this sandbox has ClusterIP, NodePort and LoadBalancer Services, not "${typeRaw}"`);
  if (p.flags.has('--protocol') && p.flags.get('--protocol') !== 'TCP') fail('error: this sandbox carries TCP only');
  const cip = p.flags.get('--cluster-ip');
  if (cip !== undefined && cip !== 'None') fail('error: this sandbox accepts --cluster-ip=None (headless) only');
  if (cip === 'None' && type !== 'ClusterIP') fail(`The Service "${p.flags.get('--name') ?? name}" is invalid: spec.clusterIPs[0]: Invalid value: ["None"]: may only be set to 'None' for ClusterIP services`);
  const svcName = String(p.flags.get('--name') ?? d.name);
  if (ctx.net.service(ns, svcName)) fail(`Error from server (AlreadyExists): services "${svcName}" already exists`);
  const sp: SvcPort = { port, targetPort: tp, protocol: 'TCP' };
  if (type !== 'ClusterIP') sp.nodePort = ctx.net.allocNodePort();
  ctx.net.services.set(`${ns}/${svcName}`, { name: svcName, ns, type, clusterIP: cip === 'None' ? 'None' : ctx.net.allocVip(), selector: { ...d.labels }, ports: [sp], labels: { ...d.labels }, created: ctx.net.t });
  record('services', svcName, ns);
  return out(`service/${svcName} exposed`);
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    return fail(`error: unable to parse "${raw}": yaml: did not find expected node content`);
  }
}

// Every field of a v1 ServiceSpec (Kubernetes 1.36). Anything else in a patch
// is an unknown field, which the real API server warns about and drops.
const SERVICE_SPEC = ['allocateLoadBalancerNodePorts', 'clusterIP', 'clusterIPs', 'externalIPs', 'externalName', 'externalTrafficPolicy', 'healthCheckNodePort', 'internalTrafficPolicy', 'ipFamilies', 'ipFamilyPolicy', 'loadBalancerClass', 'loadBalancerIP', 'loadBalancerSourceRanges', 'ports', 'publishNotReadyAddresses', 'selector', 'sessionAffinity', 'sessionAffinityConfig', 'trafficDistribution', 'type'];

function patch(ctx: Ctx, args: string[], record: (k?: string, n?: string, ns?: string) => void): Out[] {
  const p = parseArgs(args, { ...NS_FLAGS, '-p': 'value', '--patch': 'value', '--type': 'value' }, 'patch');
  const ns = nsOf(ctx, p);
  let [kindArg, name] = p.pos;
  if (kindArg?.includes('/')) [kindArg, name] = kindArg.split('/');
  const kind = KINDS[kindArg ?? ''];
  const raw = p.flags.get('-p') ?? p.flags.get('--patch');
  if (!raw) fail('error: must specify -p to patch');
  if (p.flags.has('--type') && p.flags.get('--type') !== 'strategic' && p.flags.get('--type') !== 'merge') fail('error: this sandbox applies strategic and merge patches, not --type=json');
  const body = parseJson(String(raw));
  const keys = Object.keys(body);
  if (keys.some((k) => k !== 'spec')) fail('error: this sandbox patches spec only');
  const spec = (body.spec ?? {}) as Record<string, unknown>;
  const net = ctx.net;
  // Real (kubectl 1.37.2, 1.36.1): an unknown field in a patch is a warning,
  // not an error. The rest of the patch applies, and the warnings come sorted:
  //   Warning: unknown field "spec.bogus"
  //   Warning: unknown field "spec.ports[0].bogus"
  //   service/web patched (no change)
  // An earlier version refused with a strict-decoding BadRequest, which is what
  // `apply` says, not `patch`.
  const warnings: string[] = [];
  const warned = (lines: Out[]) => [...warnings.sort().map((w) => ({ text: `Warning: unknown field "${w}"`, kind: 'err' as const })), ...lines];
  if (kind === 'services') {
    const s = structuredClone(net.service(ns, name ?? '') ?? fail(notFound(kind, name ?? '')));
    const before = JSON.stringify(s);
    for (const [k, v] of Object.entries(spec)) {
      if (!SERVICE_SPEC.includes(k)) { warnings.push(`spec.${k}`); continue; }
      if (k === 'selector') {
        if (v === null) s.selector = null;
        else if (typeof v === 'object' && !Array.isArray(v)) {
          // Strategic merge on a map merges keys; a null value removes one.
          const next = { ...(s.selector ?? {}) };
          for (const [lk, lv] of Object.entries(v as Record<string, unknown>)) { if (lv === null) delete next[lk]; else next[lk] = String(lv); }
          s.selector = next;
        } else fail('The Service is invalid: spec.selector must be a map of labels');
      } else if (k === 'type') {
        if (v !== 'ClusterIP' && v !== 'NodePort' && v !== 'LoadBalancer') fail(`The Service "${s.name}" is invalid: spec.type: Unsupported value: "${v}": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"`);
        if (s.clusterIP === 'None' && v !== 'ClusterIP') fail(`The Service "${s.name}" is invalid: spec.clusterIPs[0]: Invalid value: ["None"]: may only be set to 'None' for ClusterIP services`);
        s.type = v;
        for (const sp of s.ports) { if (v === 'ClusterIP') delete sp.nodePort; else if (!sp.nodePort) sp.nodePort = net.allocNodePort(); }
      } else if (k === 'ports') {
        if (!Array.isArray(v)) fail('error: spec.ports must be a list');
        // Strategic merge: list items are matched by "port" and merged.
        for (const [idx, item] of (v as Record<string, unknown>[]).entries()) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) fail('error: each item in spec.ports must be a mapping, like {"port":80,"targetPort":8080}');
          for (const x of Object.keys(item)) {
            if (x === 'appProtocol') fail('error: this sandbox does not model appProtocol on a Service port');
            if (!['port', 'targetPort', 'protocol', 'name', 'nodePort'].includes(x)) warnings.push(`spec.ports[${idx}].${x}`);
          }
          if (typeof item.port !== 'number' || !Number.isInteger(item.port)) fail('error: this sandbox matches patched ports by a numeric "port", as strategic merge does; add "port": 80');
          const port = item.port;
          let sp = s.ports.find((x) => x.port === port);
          if (!sp) { sp = { port, targetPort: port, protocol: 'TCP' }; s.ports.push(sp); if (s.type !== 'ClusterIP') sp.nodePort = net.allocNodePort(); }
          // Real (1.36.1): a quoted number is read as a port name, and names
          // need a letter. The index is the port's place in the merged Service.
          if (item.targetPort !== undefined) sp.targetPort = typeof item.targetPort === 'number' ? item.targetPort : /^\d+$/.test(String(item.targetPort)) ? fail(`The Service "${s.name}" is invalid: spec.ports[${s.ports.indexOf(sp)}].targetPort: Invalid value: "${item.targetPort}": must contain at least one letter (a-z)`) : String(item.targetPort);
          if (item.protocol !== undefined && item.protocol !== 'TCP') fail('error: this sandbox carries TCP only');
          if (item.name !== undefined) sp.name = String(item.name);
        }
      } else fail(`error: this sandbox patches a Service's selector, type and ports; not spec.${k}`);
    }
    // A patch is all or nothing: commit the copy only once every part passed.
    net.services.set(`${s.ns}/${s.name}`, s);
    record(kind, s.name, ns);
    return warned(out(JSON.stringify(s) === before ? `service/${s.name} patched (no change)` : `service/${s.name} patched`));
  }
  if (kind === 'ingresses') {
    const i = structuredClone(net.ingresses.get(`${ns}/${name}`) ?? fail(notFound(kind, name ?? '')));
    const before = JSON.stringify(i);
    for (const [k, v] of Object.entries(spec)) {
      if (k === 'ingressClassName') i.className = v === null ? null : String(v);
      else if (!['defaultBackend', 'tls', 'rules'].includes(k)) warnings.push(`spec.${k}`);
      else fail(`error: this sandbox patches an Ingress's ingressClassName only; edit the rest in a file and kubectl apply it`);
    }
    net.ingresses.set(`${i.ns}/${i.name}`, i);
    syncIngress(net);
    record(kind, i.name, ns);
    return warned(out(JSON.stringify(i) === before ? `ingress.networking.k8s.io/${i.name} patched (no change)` : `ingress.networking.k8s.io/${i.name} patched`));
  }
  return fail('error: this sandbox patches services and ingresses');
}

function setSelector(ctx: Ctx, args: string[], record: (k?: string, n?: string, ns?: string) => void): Out[] {
  const [sub, ...rest] = args;
  if (sub !== 'selector') fail(`kubectl set ${sub ?? ''} is not in this sandbox; it has kubectl set selector`);
  const p = parseArgs(rest, { ...NS_FLAGS }, 'set selector');
  const ns = nsOf(ctx, p);
  let [kindArg, name, sel] = p.pos;
  if (kindArg?.includes('/')) { sel = name; [kindArg, name] = kindArg.split('/'); }
  if (KINDS[kindArg ?? ''] !== 'services') fail('error: this sandbox sets selectors on services: kubectl set selector svc NAME app=x');
  const s = ctx.net.service(ns, name ?? '') ?? fail(notFound('services', name ?? ''));
  if (!sel) fail('error: expected a selector, e.g. app=web');
  const next: Labels = {};
  for (const part of sel.split(',')) {
    const m = /^([\w./-]+)=([\w.-]+)$/.exec(part);
    if (!m) fail(`error: invalid selector "${part}": expected key=value`);
    next[m[1]] = m[2];
  }
  s.selector = next;
  record('services', s.name, ns);
  return out(`service/${s.name} selector updated`);
}

function scale(ctx: Ctx, args: string[], record: (k?: string, n?: string, ns?: string) => void): Out[] {
  const p = parseArgs(args, { ...NS_FLAGS, '--replicas': 'value' }, 'scale');
  const ns = nsOf(ctx, p);
  let [kindArg, name] = p.pos;
  if (kindArg?.includes('/')) [kindArg, name] = kindArg.split('/');
  if (KINDS[kindArg ?? ''] !== 'deployments') fail('error: this sandbox scales deployments');
  const r = Number(p.flags.get('--replicas'));
  if (!p.flags.has('--replicas')) fail('error: required flag(s) "replicas" not set');
  if (!Number.isInteger(r) || r < 0 || r > 6) fail('error: this sandbox runs 0 to 6 replicas');
  if (ns === 'kube-system' && name === 'coredns') {
    ctx.net.scaleCoreDns(r);
    record('deployments', name, ns);
    return out('deployment.apps/coredns scaled');
  }
  const d = ctx.net.deployments.get(`${ns}/${name}`) ?? fail(notFound('deployments', name ?? ''));
  d.replicas = r;
  ctx.net.reconcile(d);
  record('deployments', name, ns);
  return out(`deployment.apps/${name} scaled`);
}

function label(ctx: Ctx, args: string[], record: (k?: string, n?: string, ns?: string) => void): Out[] {
  const p = parseArgs(args, { ...NS_FLAGS, '--overwrite': 'bool' }, 'label');
  const ns = nsOf(ctx, p);
  let [kindArg, name, ...pairs] = p.pos;
  if (kindArg?.includes('/')) { pairs = [name, ...pairs].filter(Boolean); [kindArg, name] = kindArg.split('/'); }
  const kind = KINDS[kindArg ?? ''];
  let labels: Labels;
  let shown: string;
  if (kind === 'namespaces') { labels = (ctx.net.namespaces.get(name ?? '') ?? fail(notFound('namespaces', name ?? ''))).labels; shown = `namespace/${name}`; }
  else if (kind === 'pods') { labels = (ctx.net.pod(ns, name ?? '') ?? fail(notFound('pods', name ?? ''))).labels; shown = `pod/${name}`; }
  else return fail('error: this sandbox labels namespaces and pods');
  if (!pairs.length) fail('error: at least one label update is required');
  for (const pr of pairs) {
    const rm = /^([\w./-]+)-$/.exec(pr);
    if (rm) { if (rm[1] === 'kubernetes.io/metadata.name') fail('error: kubernetes.io/metadata.name is set by Kubernetes and cannot be removed'); delete labels[rm[1]]; continue; }
    const m = /^([\w./-]+)=([\w.-]*)$/.exec(pr);
    if (!m) fail(`error: invalid label spec: ${pr}`);
    if (labels[m[1]] !== undefined && labels[m[1]] !== m[2] && !p.flags.has('--overwrite')) fail(`error: '${m[1]}' already has a value (${labels[m[1]]}), and --overwrite is false`);
    labels[m[1]] = m[2];
  }
  record(kind, name, ns);
  return out(`${shown} labeled`);
}

function del(ctx: Ctx, args: string[], record: (k?: string, n?: string, ns?: string) => void): Out[] {
  const p = parseArgs(args, { ...NS_FLAGS, '-f': 'value' }, 'delete');
  const ns = nsOf(ctx, p);
  const net = ctx.net;
  if (p.flags.has('-f')) fail('error: this sandbox deletes by kind and name: kubectl delete netpol NAME');
  let [kindArg, ...names] = p.pos;
  if (kindArg?.includes('/')) { names = [kindArg.split('/')[1]]; kindArg = kindArg.split('/')[0]; }
  const kind = kindArg ? kindOf(kindArg) : null;
  if (!kind) fail(kindArg ? `error: the server doesn't have a resource type "${kindArg}"` : 'error: You must provide one or more resources by argument or filename.');
  if (!names.length) fail('error: resource(s) were provided, but no name was specified');
  const lines: Out[] = [];
  for (const name of names) {
    const key = `${ns}/${name}`;
    const map = kind === 'services' ? net.services : kind === 'networkpolicies' ? net.policies : kind === 'ingresses' ? net.ingresses : kind === 'deployments' ? net.deployments : kind === 'pods' ? net.pods : null;
    if (!map) fail(`error: this sandbox deletes services, deployments, pods, networkpolicies and ingresses`);
    if (!map!.has(key)) { lines.push({ text: notFound(kind, name), kind: 'err' }); continue; }
    if (kind === 'services' && net.services.get(key)!.system) fail(`error: this sandbox keeps ${name}; deleting it would break the cluster rather than teach anything`);
    if (kind === 'pods' && name === 'client') fail('error: this sandbox keeps the client pod; every exercise runs from it');
    map!.delete(key);
    if (kind === 'deployments') for (const pd of net.podsIn(ns).filter((x) => x.owner === name)) net.pods.delete(`${pd.ns}/${pd.name}`);
    if (kind === 'pods') { const owner = [...net.deployments.values()].find((d) => d.ns === ns && name.startsWith(d.name + '-')); if (owner) net.reconcile(owner); }
    record(kind, name, ns);
    lines.push({ text: `${QUALIFIED[kind][0]} "${name}" deleted from ${ns} namespace`, kind: 'out' });
  }
  return lines;
}

function apply(ctx: Ctx, args: string[], record: (k?: string, n?: string, ns?: string) => void): Out[] {
  const p = parseArgs(args, { ...NS_FLAGS, '-f': 'value', '--filename': 'value' }, 'apply');
  const file = String(p.flags.get('-f') ?? p.flags.get('--filename') ?? fail('error: must specify one of -f and -k'));
  if (file === '-') fail('error: this terminal has no stdin; save the manifest in the editor and apply it by name');
  const src = ctx.files[file];
  if (src === undefined) fail(`error: the path "${file}" does not exist${Object.keys(ctx.files).length ? ` (files here: ${Object.keys(ctx.files).join(', ')})` : ''}`);
  const res = applyManifest(ctx.net, src, file, nsOf(ctx, p), p.flags.has('-n') || p.flags.has('--namespace'));
  for (const r of res.applied) { ctx.events.push({ type: 'apply', ...r }); record(r.kind, r.name, r.ns); }
  syncIngress(ctx.net);
  return [...res.lines.map((t) => ({ text: t, kind: 'out' as const })), ...res.errors.map((t) => ({ text: t, kind: 'err' as const }))];
}

// ---- exec: curl, nslookup, cat ---------------------------------------------

function exec(ctx: Ctx, args: string[], record: (k?: string, n?: string, ns?: string) => void): Out[] {
  const p = parseArgs(args, { ...NS_FLAGS, '-i': 'bool', '-t': 'bool', '-it': 'bool', '-ti': 'bool', '-c': 'value' }, 'exec');
  const ns = nsOf(ctx, p);
  if (!p.after) fail('error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead');
  let podName = p.pos[0];
  if (!podName) fail('error: expected \'exec POD_NAME COMMAND [ARG1] [ARG2] ... [ARGN]\'.\nPOD_NAME and COMMAND are required arguments for the exec command');
  if (podName.startsWith('pod/')) podName = podName.slice(4);
  if (podName.startsWith('deploy/') || podName.startsWith('deployment/')) {
    const d = ctx.net.deployments.get(`${ns}/${podName.split('/')[1]}`) ?? fail(notFound('deployments', podName.split('/')[1]));
    podName = ctx.net.podsIn(ns).find((x) => x.owner === d.name)?.name ?? fail(`error: no pods for deployment ${d.name}`);
  }
  const pod = ctx.net.pod(ns, podName) ?? fail(notFound('pods', podName));
  const [cmd, ...cargs] = p.after!;
  record('pods', pod.name, ns);
  if (!cmd) fail('error: you must specify at least one command for the container');
  // The panda images ship curl and busybox's nslookup, so any pod can test a
  // connection; real app images often don't, which is why people keep a client pod.
  const isTool = pod.image.startsWith('curlimages/') || pod.image.startsWith('busybox') || pod.image.startsWith('panda/');
  if (cmd === 'curl') {
    if (!isTool) fail(`OCI runtime exec failed: exec failed: unable to start container process: exec: "curl": executable file not found in $PATH: unknown\ncommand terminated with exit code 126`);
    return podCurl(ctx, pod, cargs);
  }
  if (cmd === 'nslookup') {
    if (!isTool) fail(`OCI runtime exec failed: exec failed: unable to start container process: exec: "nslookup": executable file not found in $PATH: unknown\ncommand terminated with exit code 126`);
    return nslookup(ctx, pod, cargs);
  }
  if (cmd === 'cat' && cargs.length === 1 && cargs[0] === '/etc/resolv.conf') {
    return out(`search ${ctx.net.searchList(pod.ns).join(' ')}\nnameserver ${DNS_IP}\noptions ndots:5`);
  }
  if (cmd === 'wget') fail('wget is not in this sandbox; use curl (curl -sS -m 5 URL)');
  if (cmd === 'sh' || cmd === 'bash') fail('An interactive shell is not in this sandbox. Run one command at a time: kubectl exec client -- curl ...');
  return fail(`this sandbox runs curl, nslookup and cat /etc/resolv.conf in a pod, not ${cmd}`);
}

type CurlOpts = { url: string; maxTime?: number; quiet: boolean; showErr: boolean; writeOut?: string; devnull: boolean; method: 'GET' | 'POST'; head: boolean };

function curlArgs(args: string[]): CurlOpts {
  const o: CurlOpts = { url: '', quiet: false, showErr: false, devnull: false, method: 'GET', head: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-[sSfv]+$/.test(a) && !a.includes('v') && !a.includes('f')) { if (a.includes('s')) o.quiet = true; if (a.includes('S')) o.showErr = true; continue; }
    if (a === '--silent') { o.quiet = true; continue; }
    if (a === '--show-error') { o.showErr = true; continue; }
    if (a === '-m' || a === '--max-time' || a === '--connect-timeout') { const v = Number(args[++i]); if (!(v > 0)) fail(`curl: option ${a}: expected a proper numerical parameter`); o.maxTime = v; continue; }
    if (a === '-o' || a === '--output') { if (args[++i] !== '/dev/null') fail('this sandbox has no files to write; use -o /dev/null'); o.devnull = true; continue; }
    if (a === '-w' || a === '--write-out') { o.writeOut = args[++i] ?? fail('curl: option -w: requires parameter'); if (o.writeOut.replace(/%\{http_code\}/g, '').replace(/\\n/g, '').trim()) fail("this sandbox's -w understands %{http_code} and \\n only"); continue; }
    if (a === '-X' || a === '--request') { const m = (args[++i] ?? '').toUpperCase(); if (m !== 'GET' && m !== 'POST') fail('this sandbox sends GET and POST'); o.method = m; continue; }
    if (a === '-I' || a === '--head') { o.head = true; continue; }
    if (a.startsWith('-')) fail(`curl: option ${a} is not in this sandbox (it has -s -S -m -o /dev/null -w -X -I)`);
    if (o.url) fail('this sandbox fetches one URL at a time');
    o.url = a;
  }
  if (!o.url) fail("curl: no URL specified\ncurl: try 'curl --help' or 'curl --manual' for more information");
  return o;
}

function parseUrl(raw: string): { host: string; port: number; path: string; scheme: string } {
  const m = /^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?(\/[^?#]*)?$/.exec(raw);
  if (!m) fail(`curl: (3) URL rejected: Bad hostname`);
  const scheme = m![1] ?? 'http';
  if (scheme === 'https') fail('This sandbox speaks plain HTTP only. Real clusters terminate TLS at an Ingress controller or Gateway; see the ingress lesson.');
  return { scheme, host: m![2], port: m![3] ? Number(m![3]) : 80, path: m![4] ?? '/' };
}

function curlFailure(o: CurlOpts, a: Exclude<Attempt, { ok: true }>, host: string, port: number, fromMesh: boolean): Out[] {
  const lines: Out[] = [];
  let msg: string, code: number;
  if (a.stage === 'dns' && a.how === 'timeout' && o.maxTime !== undefined && o.maxTime <= 5) {
    // Measured: with DNS unreachable the resolver gives up after about five
    // seconds, so a -m 5 runs out first: "Resolving timed out after 5003 milliseconds".
    msg = `curl: (28) Resolving timed out after ${Math.round(o.maxTime * 1000) + 3} milliseconds`; code = 28;
  } else if (a.stage === 'dns') {
    // Measured: curl 8.11.1 (musl) prints this both for NXDOMAIN and, with a
    // longer -m, when no DNS server answers (after ~5 s).
    msg = `curl: (6) Could not resolve host: ${host}`; code = 6;
  } else if (a.how === 'refused' && fromMesh) {
    // Measured on tilt (Istio 1.28.3 ambient): from a pod in the mesh, the
    // local ztunnel accepts the connection, so a refusal behind it (wrong
    // targetPort, or a Service with no endpoints) arrives as a reset.
    msg = 'curl: (56) Recv failure: Connection reset by peer'; code = 56;
  } else if (a.how === 'refused') {
    msg = `curl: (7) Failed to connect to ${host} port ${port} after 3 ms: Could not connect to server`; code = 7;
  } else {
    const ms = Math.round((o.maxTime ?? 0) * 1000) + 32;
    // In the mesh, the local ztunnel accepts the connection and the drop
    // happens behind it, so curl connects and then waits (measured on tilt).
    // ztunnel gives up on the tunnel after roughly ten seconds and resets the
    // connection: measured on tilt (Istio 1.28.3) with a default deny on
    // either side, -m 5 and -m 8 timed out, while -m 20, -m 40 and no -m all
    // ended in a reset after 10.6 to 15.1 s. An earlier version printed the
    // out-of-mesh 2 min 20 s timeout here. Between -m 8 and -m 20 is not
    // measured; this takes ten seconds as the line.
    if (fromMesh && (o.maxTime === undefined || o.maxTime > 10)) {
      msg = 'curl: (56) Recv failure: Connection reset by peer'; code = 56;
    } else if (o.maxTime === undefined) {
      // Measured once on tilt: with no -m, a dropped connection gave up after
      // 2 min 20 s with this message. The number is that run's, not a constant.
      msg = `curl: (28) Failed to connect to ${host} port ${port} after 139636 ms: Could not connect to server`; code = 28;
      lines.push({ text: '(a real terminal sits silent for over two minutes here first; add -m 5 to give up after five seconds)', kind: 'out' });
    } else {
      msg = fromMesh ? `curl: (28) Operation timed out after ${ms} milliseconds with 0 bytes received` : `curl: (28) Connection timed out after ${ms} milliseconds`; code = 28;
    }
  }
  if (o.writeOut) lines.push(...out(o.writeOut.replace(/%\{http_code\}/g, '000').replace(/\\n/g, '\n').replace(/\n$/, '')));
  if (!o.quiet || o.showErr) lines.push({ text: msg, kind: 'err' });
  return [...lines, { text: `command terminated with exit code ${code}`, kind: 'err' }];
}

function podCurl(ctx: Ctx, pod: Pod, args: string[]): Out[] {
  const o = curlArgs(args);
  const u = parseUrl(o.url);
  const net = ctx.net;
  let attempt: Attempt;
  // podinfo's readiness switch, which panda/web copies: POST /readyz/disable.
  if (o.method === 'POST' && (u.path === '/readyz/disable' || u.path === '/readyz/enable')) {
    attempt = net.connect(pod, u.host, u.port);
    if (attempt.ok) {
      attempt.pod.ready = u.path === '/readyz/enable';
      ctx.events.push({ type: 'curl', from: `${pod.ns}/${pod.name}`, url: o.url, attempt, host: false, ...snap(net) });
      return o.writeOut ? out(o.writeOut.replace(/%\{http_code\}/g, '202').replace(/\\n/g, '\n').replace(/\n$/, '')) : [];
    }
  } else attempt = net.connect(pod, u.host, u.port);
  if (!attempt.ok && attempt.stage === 'connect' && attempt.why === 'apiserver') fail("That is the kubernetes Service, which leads to the API server. It speaks HTTPS with client credentials, and this sandbox doesn't model it; use kubectl instead.");
  ctx.events.push({ type: 'curl', from: `${pod.ns}/${pod.name}`, url: o.url, attempt, host: false, ...snap(net) });
  if (!attempt.ok) return curlFailure(o, attempt, u.host, u.port, net.inMesh(pod.ns));
  // The connection worked, so a real server answers with an HTTP status of its
  // own here: podinfo 6.9.1 on tilt gave 404 "404 page not found" for POST
  // /foo and 405 for POST /. An earlier version printed curl's "(7) Could not
  // connect" instead, which blamed the network for an application's answer.
  if (o.method === 'POST') fail(`The request reached ${attempt.pod.name}, and a real server would answer it with an HTTP status of its own. This sandbox's panda images take POST only on /readyz/disable and /readyz/enable, so it doesn't model what POST ${u.path} returns.`);
  if (o.writeOut || o.devnull) return o.writeOut ? out(o.writeOut.replace(/%\{http_code\}/g, '200').replace(/\\n/g, '\n').replace(/\n$/, '')) : [];
  if (o.head) return out('HTTP/1.1 200 OK\nContent-Type: text/plain; charset=utf-8');
  return out(attempt.body);
}

function nslookup(ctx: Ctx, pod: Pod, args: string[]): Out[] {
  if (args.length !== 1 || args[0].startsWith('-')) fail('this sandbox runs nslookup NAME (one name, no options or server)');
  const name = args[0];
  const net = ctx.net;
  // Measured on tilt: in the mesh, busybox's output changes shape (extra
  // "canonical name" answers, misses in another order), and this sandbox
  // doesn't reproduce it. Refusing is better than printing the out-of-mesh shape.
  if (net.inMesh(pod.ns)) fail(`${pod.ns} is in the ambient mesh, so ztunnel's DNS proxy answers this pod's queries, and nslookup prints a different shape there that this sandbox doesn't model. Use curl to see whether a name resolves, or remove the namespace's istio.io/dataplane-mode label.`);
  const l = net.lookup(pod, name, 'nslookup');
  ctx.events.push({ type: 'lookup', from: `${pod.ns}/${pod.name}`, name, found: !!l.answer, how: l.how, ips: l.answer?.ips ?? [], corednsReplicas: net.corednsReplicas });
  if (l.how === 'timeout') {
    const refused = net.dnsPath(pod) === 'refused';
    return [...out(';; connection timed out; no servers could be reached\n'), ...(refused ? [{ text: `nslookup: write to '${DNS_IP}': Connection refused`, kind: 'err' as const }] : []), { text: 'command terminated with exit code 1', kind: 'err' }];
  }
  const lines = [`Server:\t\t${DNS_IP}`, `Address:\t${DNS_IP}:53`, ''];
  if (l.answer) {
    for (const ip of l.answer.ips) lines.push(`Name:\t${l.answer.fqdn}`, `Address: ${ip}`);
    lines.push('');
  }
  // busybox asks for A and AAAA for every candidate and reports each miss,
  // even when another candidate answered; then it exits 1 (measured).
  const misses = net.candidates(name, pod.ns, 'nslookup').filter((c) => c !== l.answer?.fqdn);
  for (const m of misses) lines.push(`** server can't find ${m}: NXDOMAIN`, '', `** server can't find ${m}: NXDOMAIN`, '');
  const res = out(lines.join('\n').replace(/\n+$/, '\n'));
  return misses.length ? [...res, { text: 'command terminated with exit code 1', kind: 'err' }] : res;
}

/** curl from your own machine: node ports, and *.localhost through an Ingress controller. */
function hostCurl(ctx: Ctx, args: string[]): Out[] {
  const o = curlArgs(args);
  const u = parseUrl(o.url);
  const net = ctx.net;
  const done = (attempt: Attempt): Out[] => {
    ctx.events.push({ type: 'curl', from: 'host', url: o.url, attempt, host: true, ...snap(net) });
    if (!attempt.ok) {
      const r = curlFailure(o, attempt, u.host, u.port, false);
      return r.filter((l) => !l.text.startsWith('command terminated'));
    }
    if (o.writeOut || o.devnull) return o.writeOut ? out(o.writeOut.replace(/%\{http_code\}/g, '200').replace(/\\n/g, '\n').replace(/\n$/, '')) : [];
    return out(attempt.body);
  };
  if (u.host === 'localhost' || u.host.endsWith('.localhost')) {
    if (!net.ingressController || u.port !== 80) return done({ ok: false, stage: 'connect', how: 'refused', why: 'nothing listens on localhost:' + u.port });
    const ing = [...net.ingresses.values()].find((i) => i.address && i.rules.some((r) => !r.host || r.host === u.host));
    if (!ing) {
      ctx.events.push({ type: 'curl', from: 'host', url: o.url, attempt: { ok: false, stage: 'connect', how: 'refused', why: 'no Ingress claimed this host' }, host: true, ...snap(net) });
      return o.writeOut ? out(o.writeOut.replace(/%\{http_code\}/g, '404').replace(/\\n/g, '\n').replace(/\n$/, '')) : out('404 page not found (from the toy Ingress controller: no Ingress it serves has this host)');
    }
    const rule = ing.rules.find((r) => !r.host || r.host === u.host)!;
    const pth = rule.paths.find((x) => (x.pathType === 'Exact' ? u.path === x.path : u.path.startsWith(x.path)));
    if (!pth) return o.writeOut ? out(o.writeOut.replace(/%\{http_code\}/g, '404').replace(/\\n/g, '\n').replace(/\n$/, '')) : out('404 page not found');
    const svc = net.service(ing.ns, pth.service);
    if (!svc) return out('503 Service Unavailable (from the toy Ingress controller: the backend Service does not exist)', 'err');
    const sp = svc.ports.find((x) => x.port === pth.port || x.name === pth.port);
    if (!sp) return out('503 Service Unavailable (from the toy Ingress controller: the Service has no such port)', 'err');
    // The controller is a pod too: its connection to the backend obeys policy.
    const ctl = net.podsIn('ingress-panda')[0];
    const a = net.connect(ctl, svc.clusterIP, sp.port);
    if (!a.ok) {
      ctx.events.push({ type: 'curl', from: 'host', url: o.url, attempt: a, host: true, ...snap(net) });
      return o.writeOut ? out(o.writeOut.replace(/%\{http_code\}/g, '503').replace(/\\n/g, '\n').replace(/\n$/, '')) : out('503 Service Unavailable (from the toy Ingress controller: it could not reach the backend)', 'err');
    }
    return done(a);
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(u.host)) return done({ ok: false, stage: 'dns', how: 'nxdomain', name: u.host });
  const node = net.nodeByIp(u.host);
  const svc = [...net.services.values()].find((s) => s.clusterIP === u.host || s.externalIP === u.host);
  if (svc) fail(`${u.host} is a Service's cluster IP. It only exists inside the cluster, so your machine has no route to it. Try it from a pod, or use a NodePort.`);
  if (/^10\.244\./.test(u.host)) fail(`${u.host} is a pod IP. Pod IPs are routable inside the cluster, not from your machine. Try it from a pod.`);
  if (!node) return done({ ok: false, stage: 'connect', how: 'timeout', why: 'no such host' });
  const r = net.route(u.host, u.port);
  if ('none' in r) return done({ ok: false, stage: 'connect', how: 'refused', why: r.none });
  if (net.enforcing && net.policiesFor(r.pod, 'Ingress').length)
    fail('This sandbox does not model NetworkPolicy for traffic from outside the cluster (it arrives through the node, often with its source address rewritten). Try it from a pod instead.');
  const img = IMAGES[r.pod.image];
  if (!img || img.listen !== r.port) return done({ ok: false, stage: 'connect', how: 'refused', why: 'nothing listens there', pod: r.pod });
  return done({ ok: true, body: img.body(r.pod), pod: r.pod, via: r.via });
}

export { NODES };
