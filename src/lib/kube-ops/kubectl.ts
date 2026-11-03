// Commands for the ops sandbox: kubectl, `docker exec` into a kind node, and
// the tools on that node (systemctl, journalctl, crictl, kubeadm, etcdctl,
// etcdutl). Messages are copied from real runs on kind (1.35.0 and 1.36.1
// nodes, kubectl 1.37.2, kubeadm 1.36.1 and 1.37.2, etcd 3.6.8) while the
// lessons were written; tests/kube-ops.test.ts pins them and names the command.

import { Ops, SECONDS_PER_TICK, COMPONENTS, ver, type Node, type Pod, type Component } from './ops.ts';
import { table, human, eventsBlock, tokenize, parseFlags, goDuration, goDurationString, CmdError, type Out } from './print.ts';

export type Seen = (what: string) => void;
/** A long-running command (drain) prints over time; the widget feeds its lines to the terminal each tick. */
export type Job = { kind: 'drain'; node: string; deadline: number; next: number; selector?: string; onLine: (l: Out[]) => void; done: boolean; ok?: boolean };

const o = (text: string): Out[] => text ? text.split('\n').map((t) => ({ text: t, kind: 'out' as const })) : [];
const e = (text: string): Out[] => text.split('\n').map((t) => ({ text: t, kind: 'err' as const }));
const note = (text: string): Out => ({ text, kind: 'dim' });

// `kubectl get ns` when no API server answers. Copied with the kube-apiserver
// manifest moved out of /etc/kubernetes/manifests on a kind node. EOF is
// kind's wording: Docker's port forward accepts the connection, then closes
// it. Where nothing at all listens on the port (a kubeadm VM), kubectl says
// `The connection to the server <host>:6443 was refused - did you specify the
// right host or port?` instead; the control-plane lesson's table says so.
// This sandbox is a kind cluster, so it prints kind's.
export const API_DOWN = 'Unable to connect to the server: EOF';

export type Ctx = { ops: Ops; jobs: Job[]; seen: Seen };

export function run(ctx: Ctx, line: string): Out[] {
  try {
    const w = tokenize(line.trim());
    if (!w.length) return [];
    if (w[0] === 'help') return o(HELP);
    if (w[0] === 'ls') return o([...ctx.ops.hostFiles.keys()].sort().join('  ') || '(nothing here)');
    if (w[0] === 'docker') return docker(ctx, w.slice(1));
    if (w[0] !== 'kubectl') throw new CmdError(`sandbox: ${w[0]}: command not found here. Type help for what this sandbox runs.`);
    return kubectl(ctx, w.slice(1));
  } catch (x) {
    if (x instanceof CmdError) return e(x.message);
    return e(`a bug in the sandbox, not in your command: ${(x as Error).message}`);
  } finally {
    // A restarted kubelet takes its new version at once; the skew record must see it then.
    ctx.ops.noteSkew();
  }
}

export const HELP = `A kind cluster called ops. Time runs on its own; each tick is ${SECONDS_PER_TICK} seconds.
  kubectl get nodes|pods|deploy|pdb|ns|events [-n ns | -A] [-o wide]     kubectl get --raw /readyz
  kubectl describe node|pod|pdb <name>     kubectl version
  kubectl create deployment <name> --image=<img> --replicas=N    kubectl run <name> --image=<img>
  kubectl create pdb <name> --selector=app=<x> --min-available=N | --max-unavailable=N
  kubectl create namespace <name>      kubectl patch pdb <name> -p '<json>'
  kubectl delete pod|deploy|pdb|ns <name>     kubectl scale deploy <name> --replicas=N
  kubectl cordon|uncordon <node>       kubectl drain <node> [--ignore-daemonsets] [--force] [--timeout=60s] [--dry-run=client]
  kubectl -n kube-system exec etcd-<node> -- etcdctl <flags> member list|endpoint status|snapshot save <path>
  kubectl -n kube-system exec etcd-<node> -- etcdutl ...
  docker exec <node> ls|mv|systemctl|journalctl|crictl|kubeadm|sed ...
  docker cp <file> <node>:/usr/bin/<kubeadm|kubelet>     ls (files on your machine)`;

const age = (o: Ops, since: number) => human(o.seconds - since * SECONDS_PER_TICK);

function api(ctx: Ctx, what = 'resources') {
  const s = ctx.ops.api();
  if (s === 'down') { ctx.seen('api-down'); throw new CmdError(API_DOWN); }
  if (s === 'no-quorum') {
    ctx.seen('api-no-quorum');
    // One member, stopped: copied from kubectl get ns on a one-node kind
    // cluster with etcd.yaml moved out (later attempts timed out in TLS).
    if (ctx.ops.etcdMembers().length === 1) throw new CmdError(`Error from server (Timeout): the server was unable to return a response in the time allotted, but may still be processing the request (get ${what})`);
    throw new CmdError(NO_QUORUM);
  }
}
const PLURAL: Record<string, string> = { node: 'nodes', pod: 'pods', deploy: 'deployments.apps', pdb: 'poddisruptionbudgets.policy', ns: 'namespaces', ev: 'events' };
// Not copied: kind could not start a multi-control-plane cluster on this
// machine while these lessons were written (inotify limits, see the lesson),
// so the sandbox says what is true and does not invent kubectl's words.
export const NO_QUORUM = `sandbox: etcd has fewer members up than its quorum, so it cannot commit a write, and the sandbox refuses every request. On a real cluster writes fail; whether some reads still come back from the API server's cache, and kubectl's exact words, we could not test (no HA cluster would run on our machine).`;

const KINDS: Record<string, string> = { no: 'node', node: 'node', nodes: 'node', po: 'pod', pod: 'pod', pods: 'pod', deploy: 'deploy', deployment: 'deploy', deployments: 'deploy', pdb: 'pdb', poddisruptionbudget: 'pdb', poddisruptionbudgets: 'pdb', ns: 'ns', namespace: 'ns', namespaces: 'ns', ev: 'ev', event: 'ev', events: 'ev' };
const kindOf = (w: string | undefined) => {
  if (!w) throw new CmdError('error: you must specify the type of resource to get');
  const k = KINDS[w.toLowerCase()];
  if (!k) throw new CmdError(['pvc', 'pv', 'sc', 'sts', 'svc', 'cm', 'secret', 'ds', 'rs', 'job'].includes(w) ? `sandbox: this ops sandbox does not model ${w}. It knows nodes, pods, deploy, pdb, ns and events.` : `error: the server doesn't have a resource type "${w}"`);
  return k;
};

const VALUED = new Set(['-n', '--namespace', '-o', '--output', '--image', '--replicas', '--selector', '--min-available', '--max-unavailable', '-p', '--patch', '--timeout', '--dry-run', '--raw', '--pod-selector', '--type']);
const KNOWN = new Set([...VALUED, '-A', '--all-namespaces', '--ignore-daemonsets', '--force', '--delete-emptydir-data', '-w', '--watch', '--client', '--disable-eviction', '--grace-period', '--now']);

function kubectl(ctx: Ctx, args: string[]): Out[] {
  // Flags may come before the verb: kubectl -n kube-system exec ...
  let ns = 'default';
  const pre: string[] = [];
  while (args[0]?.startsWith('-')) {
    const a = args.shift()!;
    if (a === '-n' || a === '--namespace') ns = args.shift() ?? 'default';
    else if (a.startsWith('--namespace=')) ns = a.slice(12);
    else pre.push(a);
  }
  const verb = args[0];
  const rest = [...pre, ...args.slice(1)];
  if (verb === 'exec') return execEtcd(ctx, rest, ns);
  const { pos, flags } = parseFlags(rest, VALUED, KNOWN);
  ns = flags.get('-n') ?? flags.get('--namespace') ?? ns;
  if (flags.has('-w') || flags.has('--watch')) throw new CmdError('sandbox: --watch keeps printing as things change; here, run the command again instead (time keeps running).');
  const all = flags.has('-A') || flags.has('--all-namespaces');
  const o_ = ctx.ops;
  switch (verb) {
    case 'version': {
      if (flags.has('--client')) return o(`Client Version: ${o_.clientVersion}\nKustomize Version: v5.8.1`);
      const lines = [`Client Version: ${o_.clientVersion}`, 'Kustomize Version: v5.8.1'];
      if (o_.api() === 'down') return [...o(lines.join('\n')), ...e(API_DOWN)];
      const sv = o_.nodes.filter((n) => n.containers.has('kube-apiserver'))[0]?.componentVersion ?? o_.serverVersion;
      lines.push(`Server Version: ${sv}`);
      ctx.seen('version');
      // kubectl's own warning, as it printed for a 1.37 client against a 1.35 server.
      if (Math.abs(ver(o_.clientVersion).minor - ver(sv).minor) > 1) lines.push(`Warning: version difference between client (1.${ver(o_.clientVersion).minor}) and server (1.${ver(sv).minor}) exceeds the supported minor version skew of +/-1`);
      return o(lines.join('\n'));
    }
    case 'get': {
      if (flags.has('--raw')) { api(ctx); return raw(ctx, flags.get('--raw')!); }
      const k = kindOf(pos[0]?.split('/')[0]);
      api(ctx, PLURAL[k]);
      ctx.seen(`get:${k}`);
      return get(ctx, k, pos.slice(1).concat(pos[0]?.includes('/') ? [pos[0].split('/')[1]] : []), ns, all, flags.get('-o') ?? flags.get('--output'));
    }
    case 'describe': {
      api(ctx);
      const k = kindOf(pos[0]?.split('/')[0]);
      const name = pos[1] ?? pos[0]?.split('/')[1];
      if (!name) throw new CmdError(`sandbox: name the ${k}: kubectl describe ${k} <name>`);
      ctx.seen(`describe:${k}:${name}`);
      return o(describe(ctx, k, name, ns));
    }
    case 'create': return create(ctx, pos, flags, ns);
    case 'run': {
      api(ctx);
      const name = pos[0], image = flags.get('--image');
      if (!name || !image) throw new CmdError('error: required flag(s) "image" not set');
      if (o_.pods.has(`${ns}/${name}`)) throw new CmdError(`Error from server (AlreadyExists): pods "${name}" already exists`);
      o_.addPod({ name, ns, app: name, image, owner: { kind: 'none', name: '' } });
      return o(`pod/${name} created`);
    }
    case 'delete': {
      api(ctx);
      const k = kindOf(pos[0]?.split('/')[0]);
      const names = pos[0]?.includes('/') ? [pos[0].split('/')[1], ...pos.slice(1)] : pos.slice(1);
      if (!names.length) throw new CmdError('error: resource(s) were provided, but no name was specified');
      return names.flatMap((n) => del(ctx, k, n, ns));
    }
    case 'scale': {
      api(ctx);
      const k = kindOf(pos[0]?.split('/')[0]);
      const name = pos[0]?.includes('/') ? pos[0].split('/')[1] : pos[1];
      const d = o_.deployments.get(`${ns}/${name}`);
      if (k !== 'deploy') throw new CmdError('sandbox: only deployments scale here.');
      if (!d) throw new CmdError(`Error from server (NotFound): deployments.apps "${name}" not found`);
      const n = Number(flags.get('--replicas'));
      if (!Number.isInteger(n) || n < 0) throw new CmdError('error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0');
      d.replicas = n;
      return o(`deployment.apps/${name} scaled`);
    }
    case 'patch': return patchPdb(ctx, pos, flags, ns);
    case 'cordon': case 'uncordon': {
      api(ctx);
      const n = nodeArg(o_, pos[0], verb);
      const want = verb === 'cordon';
      if (n.unschedulable === want) return o(`node/${n.name} already ${verb}ed`);
      n.unschedulable = want;
      ctx.seen(`${verb}:${n.name}`);
      return o(`node/${n.name} ${verb}ed`);
    }
    case 'drain': return drain(ctx, pos, flags);
    case 'logs': throw new CmdError('sandbox: kubectl logs is not modelled in this ops sandbox; the node\'s own log is: docker exec <node> journalctl -u kubelet');
    default: throw new CmdError(`sandbox: kubectl ${verb ?? ''} is not part of this ops sandbox. Type help for the list.`);
  }
}

function nodeArg(o_: Ops, name: string | undefined, verb: string): Node {
  if (!name) throw new CmdError(`error: USAGE: ${verb} NODE [flags]\nSee 'kubectl ${verb} -h' for help and examples`);
  const n = o_.node(name);
  if (!n) throw new CmdError(`Error from server (NotFound): nodes "${name}" not found`);
  return n;
}

function raw(ctx: Ctx, path: string): Out[] {
  const p = path.replace(/\?.*$/, '');
  if (p !== '/readyz' && p !== '/livez') throw new CmdError(`sandbox: only /readyz and /livez are modelled for --raw.`);
  ctx.seen(`raw:${p}`);
  // The API server's own health. With the scheduler or the controller-manager
  // stopped it still said ok: readyz is about the API server, not the cluster.
  // The real verbose list has dozens of poststarthook lines; the sandbox keeps a few and says so on screen.
  if (path.includes('verbose')) return [...o(['[+]ping ok', '[+]log ok', '[+]etcd ok', '[+]etcd-readiness ok', '[+]informer-sync ok', '[+]poststarthook/start-apiserver-admission-initializer ok', '[+]shutdown ok', `${p.slice(1)} check passed`].join('\n')),
    note('(sandbox: list trimmed; a real API server prints dozens more [+]poststarthook/... lines before the last one)')];
  return o('ok');
}

function roles(n: Node) { return n.controlPlane ? 'control-plane' : '<none>'; }

function get(ctx: Ctx, k: string, names: string[], ns: string, all: boolean, fmt?: string): Out[] {
  const o_ = ctx.ops;
  if (fmt && fmt !== 'wide') throw new CmdError(`sandbox: -o ${fmt} is not modelled here; only -o wide.`);
  const wide = fmt === 'wide';
  const none = (scope = true) => o(scope && !all ? `No resources found in ${ns} namespace.` : 'No resources found');
  if (k === 'node') {
    let list = o_.nodes;
    if (names.length) list = names.map((n) => nodeArg(o_, n, 'get'));
    const rows = list.map((n, i) => [n.name, (n.ready ? 'Ready' : 'NotReady') + (n.unschedulable ? ',SchedulingDisabled' : ''), roles(n), '6m', n.kubelet.version,
      ...(wide ? [`172.18.0.${i + 2}`, '<none>', 'Debian GNU/Linux 13 (trixie)', '6.18.33.2-microsoft-standard-WSL2', 'containerd://2.3.1'] : [])]);
    for (const n of list) if (!n.ready) ctx.seen(`saw-notready:${n.name}`);
    return o(table([['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION', ...(wide ? ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'] : [])], ...rows]));
  }
  if (k === 'pod') {
    let list = [...o_.pods.values()].filter((p) => all || p.ns === ns).sort((a, b) => a.ns.localeCompare(b.ns) || a.name.localeCompare(b.name));
    if (names.length) list = names.map((n) => { const p = o_.pods.get(`${ns}/${n}`); if (!p) throw new CmdError(`Error from server (NotFound): pods "${n}" not found`); return p; });
    if (!list.length) return none();
    for (const p of list) {
      const n = p.node ? o_.node(p.node) : undefined;
      if (n && !n.ready && p.status === 'Running') ctx.seen('saw-stale-running');
      if (p.status === 'Terminating' && p.deleting === Infinity) ctx.seen('saw-evicted');
    }
    const rows = list.map((p) => [...(all ? [p.ns] : []), p.name, `${p.ready || (p.status === 'Terminating' && p.deleting === Infinity) ? 1 : 0}/1`, p.status, '0', age(o_, p.created),
      ...(wide ? [p.node && p.status !== 'Pending' ? o_.podIP(p) : '<none>', p.node ?? '<none>', '<none>', '<none>'] : [])]);
    return o(table([[...(all ? ['NAMESPACE'] : []), 'NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : [])], ...rows]));
  }
  if (k === 'deploy') {
    const list = [...o_.deployments.values()].filter((d) => all || d.ns === ns);
    if (!list.length) return none();
    if (!o_.running('kube-controller-manager')) for (const d of list) if (d.status.ready !== [...o_.pods.values()].filter((p) => p.app === d.name && p.ready).length) ctx.seen('saw-stale-deploy');
    return o(table([[...(all ? ['NAMESPACE'] : []), 'NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'], ...list.map((d) => [...(all ? [d.ns] : []), d.name, `${d.status.ready}/${d.replicas}`, String(d.status.upToDate), String(d.status.available), age(o_, d.created)])]));
  }
  if (k === 'pdb') {
    const list = [...o_.pdbs.values()].filter((b) => all || b.ns === ns);
    if (!list.length) return none();
    return o(table([[...(all ? ['NAMESPACE'] : []), 'NAME', 'MIN AVAILABLE', 'MAX UNAVAILABLE', 'ALLOWED DISRUPTIONS', 'AGE'], ...list.map((b) => [...(all ? [b.ns] : []), b.name, String(b.minAvailable ?? 'N/A'), String(b.maxUnavailable ?? 'N/A'), String(b.status.allowed), age(o_, b.created)])]));
  }
  if (k === 'ns') {
    const list = (o_.cache?.namespaces ?? [...o_.namespaces.keys()]).slice().sort();
    // For the restore mission: what the API showed while etcd served a restored snapshot.
    if (o_.restoredFor()) ctx.seen(`restored-view:after-snap:${list.includes('after-snap')}`);
    if (names.length) {
      const outp: Out[] = [];
      const found = names.filter((n) => list.includes(n));
      if (found.length) outp.push(...o(table([['NAME', 'STATUS', 'AGE'], ...found.map((n) => [n, 'Active', age(o_, o_.namespaces.get(n) ?? 0)])])));
      for (const n of names) if (!list.includes(n)) outp.push(...e(`Error from server (NotFound): namespaces "${n}" not found`));
      for (const n of names) ctx.seen(`get-ns:${n}:${list.includes(n)}`);
      return outp;
    }
    for (const n of ['after-snap']) ctx.seen(`get-ns:${n}:${list.includes(n)}`);
    return o(table([['NAME', 'STATUS', 'AGE'], ...list.map((n) => [n, 'Active', age(o_, o_.namespaces.get(n) ?? 0)])]));
  }
  if (k === 'ev') {
    const rows: [number, string[]][] = [];
    for (const p of o_.pods.values()) if (all || p.ns === ns) for (const ev of p.events) rows.push([ev.last, [...(all ? [p.ns] : []), age(o_, ev.last), ev.type, ev.reason, `pod/${p.name}`, ev.message]]);
    if (all || ns === 'default') for (const n of o_.nodes) for (const ev of n.events) rows.push([ev.last, [...(all ? ['default'] : []), age(o_, ev.last), ev.type, ev.reason, `node/${n.name}`, ev.message]]);
    if (!rows.length) return none();
    rows.sort((a, b) => a[0] - b[0]);
    return o(table([[...(all ? ['NAMESPACE'] : []), 'LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], ...rows.map((r) => r[1])]));
  }
  throw new CmdError(`sandbox: get ${k} is not modelled`);
}

const fmtTime = (o_: Ops, tick: number) => {
  // A fixed clock face for the conditions table: the real one prints wall-clock times.
  const d = new Date(Date.UTC(2026, 10, 3, 6, 0, 0) + tick * SECONDS_PER_TICK * 1000);
  const dd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  void o_;
  return `${dd}, ${String(d.getUTCDate()).padStart(2, '0')} Nov 2026 ${d.toISOString().slice(11, 19)} +0000`;
};

function describe(ctx: Ctx, k: string, name: string, ns: string): string {
  const o_ = ctx.ops;
  if (k === 'node') {
    const n = nodeArg(o_, name, 'describe');
    if (!n.ready) ctx.seen(`described-notready:${n.name}`);
    const beat = fmtTime(o_, n.lastBeat), since = fmtTime(o_, n.notReadySince ?? 0);
    const cond = n.ready
      ? [['MemoryPressure', 'False', beat, fmtTime(o_, 0), 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'], ['DiskPressure', 'False', beat, fmtTime(o_, 0), 'KubeletHasNoDiskPressure', 'kubelet has no disk pressure'],
        ['PIDPressure', 'False', beat, fmtTime(o_, 0), 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'], ['Ready', 'True', beat, fmtTime(o_, 0), 'KubeletReady', 'kubelet is posting ready status']]
      : ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'Ready'].map((c) => [c, 'Unknown', beat, since, 'NodeStatusUnknown', 'Kubelet stopped posting node status.']);
    const taints = n.taints.length ? n.taints.map((t) => `${t.key}:${t.effect}`) : ['<none>'];
    // Real describe selects by phase (status.phase!=Succeeded,!=Failed, kubectl
    // pkg/describe), and an evicted pod stuck in Terminating is still Running
    // by phase. So it is listed, which is exactly what makes it worth reading.
    const pods = [...o_.pods.values()].filter((p) => p.node === n.name);
    return [
      `Name:               ${n.name}`, `Roles:              ${roles(n)}`,
      `Taints:             ${taints[0]}`, ...taints.slice(1).map((t) => `                    ${t}`),
      `Unschedulable:      ${n.unschedulable}`,
      'Conditions:', table([['Type', 'Status', 'LastHeartbeatTime', 'LastTransitionTime', 'Reason', 'Message'], ['----', '------', '-----------------', '------------------', '------', '-------'], ...cond]).split('\n').map((l) => '  ' + l).join('\n'),
      'System Info:', `  Kubelet Version:            ${n.kubelet.version}`, '  Container Runtime Version:  containerd://2.3.1',
      `Non-terminated Pods:          (${pods.length} in total)`,
      table([['Namespace', 'Name'], ['---------', '----'], ...pods.map((p) => [p.ns, p.name])]).split('\n').map((l) => '  ' + l).join('\n'),
      eventsBlock(n.events, o_.seconds, SECONDS_PER_TICK),
    ].join('\n');
  }
  if (k === 'pod') {
    const p = o_.pods.get(`${ns}/${name}`);
    if (!p) throw new CmdError(`Error from server (NotFound): pods "${name}" not found`);
    if (!p.node) ctx.seen(`described-unscheduled:${p.name}:${p.events.length}`);
    return [
      `Name:             ${p.name}`, `Namespace:        ${p.ns}`, `Node:             ${p.node ?? '<none>'}`, `Status:           ${p.status === 'ContainerCreating' ? 'Pending' : p.status}`,
      ...(p.owner.kind !== 'none' ? [`Controlled By:    ${p.owner.kind}/${p.owner.name}`] : []),
      `Image:            ${p.image}`,
      ...podConditions(o_, p),
      ...(p.owner.kind === 'DaemonSet' || p.owner.kind === 'Node' ? [] : ['Tolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s', '                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s']),
      eventsBlock(p.events, o_.seconds, SECONDS_PER_TICK),
    ].join('\n');
  }
  if (k === 'pdb') {
    const b = o_.pdbs.get(`${ns}/${name}`);
    if (!b) throw new CmdError(`Error from server (NotFound): poddisruptionbudgets.policy "${name}" not found`);
    return [`Name:           ${b.name}`, `Namespace:      ${b.ns}`, b.minAvailable !== undefined ? `Min available:  ${b.minAvailable}` : `Max unavailable:  ${b.maxUnavailable}`, `Selector:       app=${b.app}`,
      'Status:', `    Allowed disruptions:  ${b.status.allowed}`, `    Current:              ${b.status.current}`, `    Desired:              ${b.status.desired}`, `    Total:                ${b.status.total}`, 'Events:                   <none>'].join('\n');
  }
  throw new CmdError(`sandbox: describe ${k} is not modelled here.`);
}

/**
 * The Conditions block of `kubectl describe pod`, in the shape kubectl 1.37.2
 * printed it for a running pod on tiltdev (1.36.1), trailing spaces included.
 * Ready can be False while the READY column still says 1/1: the node
 * controller's MarkPodsNotReady sets only the Ready condition when a node goes
 * NotReady, and READY counts container statuses, which only a kubelet writes.
 * Left out on purpose: a pod still starting, whose conditions were not captured.
 */
function podConditions(o_: Ops, p: Pod): string[] {
  const row = (t: string, v: boolean) => `  ${t.padEnd(28)}${v ? 'True' : 'False'} `;
  if (!p.node) return ['Conditions:', '  Type           Status', '  PodScheduled   False '];
  if (p.status === 'ContainerCreating') return [];
  return ['Conditions:', `  ${'Type'.padEnd(28)}Status`, row('PodReadyToStartContainers', true), row('Initialized', true), row('Ready', o_.podReady(p)), row('ContainersReady', p.ready), row('PodScheduled', true)];
}

function create(ctx: Ctx, pos: string[], flags: Map<string, string>, ns: string): Out[] {
  const o_ = ctx.ops;
  api(ctx);
  const what = pos[0], name = pos[1];
  if (what === 'deployment' || what === 'deploy') {
    const image = flags.get('--image');
    if (!name || !image) throw new CmdError('error: required flag(s) "image" not set');
    if (o_.deployments.has(`${ns}/${name}`)) throw new CmdError(`Error from server (AlreadyExists): deployments.apps "${name}" already exists`);
    const replicas = Number(flags.get('--replicas') ?? 1);
    o_.deployments.set(`${ns}/${name}`, { name, ns, replicas, image, hash: '7d876db474', created: o_.tick, status: { ready: 0, upToDate: 0, available: 0 } });
    return o(`deployment.apps/${name} created`);
  }
  if (what === 'pdb' || what === 'poddisruptionbudget') {
    const sel = flags.get('--selector');
    if (!name) throw new CmdError('error: NAME is required for poddisruptionbudget');
    const min = flags.get('--min-available'), max = flags.get('--max-unavailable');
    // kubectl create pdb both --min-available=1 --max-unavailable=1
    if (min !== undefined && max !== undefined) throw new CmdError('error: min-available and max-unavailable cannot be both specified');
    if (!sel || !/^app=[\w-]+$/.test(sel)) throw new CmdError('sandbox: give a selector of the form --selector=app=<name>');
    if (min === undefined && max === undefined) throw new CmdError('error: one of min-available or max-unavailable must be specified');
    if (o_.pdbs.has(`${ns}/${name}`)) throw new CmdError(`Error from server (AlreadyExists): poddisruptionbudgets.policy "${name}" already exists`);
    const val = (v: string | undefined) => v === undefined ? undefined : /%$/.test(v) ? v : Number(v);
    o_.pdbs.set(`${ns}/${name}`, { name, ns, app: sel.slice(4), minAvailable: val(min), maxUnavailable: val(max), created: o_.tick, status: { allowed: 0, current: 0, desired: 0, total: 0 } });
    return o(`poddisruptionbudget.policy/${name} created`);
  }
  if (what === 'namespace' || what === 'ns') {
    if (!name) throw new CmdError('error: exactly one NAME is required, got 0');
    if (o_.namespaces.has(name)) throw new CmdError(`Error from server (AlreadyExists): namespaces "${name}" already exists`);
    o_.namespaces.set(name, o_.tick);
    o_.etcdRevision += 5;
    if (o_.cache && !o_.cache.namespaces.includes(name)) o_.cache.namespaces.push(name);
    ctx.seen(`created-ns:${name}`);
    return o(`namespace/${name} created`);
  }
  throw new CmdError(`sandbox: kubectl create ${what ?? ''} is not modelled here; deployment, pdb and namespace are.`);
}

function del(ctx: Ctx, k: string, name: string, ns: string): Out[] {
  const o_ = ctx.ops;
  if (k === 'pod') {
    const p = o_.pods.get(`${ns}/${name}`);
    if (!p) return e(`Error from server (NotFound): pods "${name}" not found`);
    // A mirror pod: deleting it removes only the API's copy, and the kubelet
    // posts it again (seen for real: Pending 0/1 six seconds later, then back).
    if (p.owner.kind === 'Node') { o_.pods.delete(`${ns}/${name}`); ctx.seen(`deleted-mirror:${p.component}`); return o(`pod "${name}" deleted from ${ns} namespace`); }
    o_.deletePod(p);
    ctx.seen(`deleted-pod:${p.app}`);
    return o(`pod "${name}" deleted from ${ns} namespace`);
  }
  if (k === 'deploy') {
    if (!o_.deployments.delete(`${ns}/${name}`)) return e(`Error from server (NotFound): deployments.apps "${name}" not found`);
    for (const p of o_.pods.values()) if (p.ns === ns && p.app === name && p.owner.kind === 'ReplicaSet') o_.deletePod(p);
    return o(`deployment.apps "${name}" deleted from ${ns} namespace`);
  }
  if (k === 'pdb') {
    if (!o_.pdbs.delete(`${ns}/${name}`)) return e(`Error from server (NotFound): poddisruptionbudgets.policy "${name}" not found`);
    ctx.seen('deleted-pdb');
    return o(`poddisruptionbudget.policy "${name}" deleted from ${ns} namespace`);
  }
  if (k === 'ns') {
    if (['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(name)) return e(`Error from server (Forbidden): namespaces "${name}" is forbidden: this namespace may not be deleted`);
    if (!o_.namespaces.delete(name)) return e(`Error from server (NotFound): namespaces "${name}" not found`);
    if (o_.cache) o_.cache.namespaces = o_.cache.namespaces.filter((n) => n !== name);
    return o(`namespace "${name}" deleted`);
  }
  throw new CmdError(`sandbox: cannot delete ${k} here`);
}

function patchPdb(ctx: Ctx, pos: string[], flags: Map<string, string>, ns: string): Out[] {
  api(ctx);
  const k = kindOf(pos[0]?.split('/')[0]);
  const name = pos[0]?.includes('/') ? pos[0].split('/')[1] : pos[1];
  if (k !== 'pdb') throw new CmdError('sandbox: only PodDisruptionBudgets are patched in this sandbox.');
  const b = ctx.ops.pdbs.get(`${ns}/${name}`);
  if (!b) throw new CmdError(`Error from server (NotFound): poddisruptionbudgets.policy "${name}" not found`);
  const rawp = flags.get('-p') ?? flags.get('--patch');
  if (!rawp) throw new CmdError('error: must specify -p to patch');
  let body: { spec?: Record<string, unknown> };
  try { body = JSON.parse(rawp); } catch { throw new CmdError(`error: unable to parse "${rawp}": the patch must be JSON, for example '{"spec":{"minAvailable":1}}'`); }
  const spec = body.spec ?? {};
  for (const key of Object.keys(spec)) if (key !== 'minAvailable' && key !== 'maxUnavailable') throw new CmdError(`sandbox: only spec.minAvailable and spec.maxUnavailable are modelled for a PodDisruptionBudget, not ${key}.`);
  const val = (v: unknown) => v === null ? undefined : typeof v === 'number' || (typeof v === 'string' && /^\d+%$/.test(v)) ? v : (() => { throw new CmdError(`sandbox: ${JSON.stringify(v)} must be a whole number or a percentage like "50%"`); })();
  const next = { min: 'minAvailable' in spec ? val(spec.minAvailable) : b.minAvailable, max: 'maxUnavailable' in spec ? val(spec.maxUnavailable) : b.maxUnavailable };
  // The API refuses a budget with both set, as kubectl create did.
  if (next.min !== undefined && next.max !== undefined) throw new CmdError(`The PodDisruptionBudget "${name}" is invalid: spec: Invalid value: policy.PodDisruptionBudgetSpec{...}: minAvailable and maxUnavailable cannot be both set`);
  b.minAvailable = next.min as number | string | undefined; b.maxUnavailable = next.max as number | string | undefined;
  return o(`poddisruptionbudget.policy/${name} patched`);
}

// ---- drain -------------------------------------------------------------------

/** --timeout, parsed as kubectl parses it: before anything else happens, so a bad value cordons nothing. */
function drainTimeout(raw: string): number {
  let secs: number;
  try { secs = goDuration(raw); } catch (x) {
    throw new CmdError(`error: invalid argument "${raw}" for "--timeout" flag: ${(x as Error).message}\nSee 'kubectl drain --help' for usage.`);
  }
  // kubectl accepted -5s. What drain then does was not tried, so the sandbox says so.
  if (secs < 0) throw new CmdError('sandbox: kubectl accepts a negative --timeout, but what drain does with one was not tested for this sandbox. Use a positive one, or 0 for no limit.');
  return secs;
}

function drain(ctx: Ctx, pos: string[], flags: Map<string, string>): Out[] {
  const o_ = ctx.ops;
  const timeout = flags.get('--timeout');
  let secs = Infinity;
  // kubectl drain's help: "zero means infinite".
  if (timeout !== undefined) secs = drainTimeout(timeout) || Infinity;
  api(ctx);
  if (flags.has('--disable-eviction')) throw new CmdError('sandbox: --disable-eviction deletes pods without asking the eviction API, which skips every PodDisruptionBudget. Real, and not modelled here on purpose.');
  if (flags.has('--grace-period') || flags.has('--now')) throw new CmdError('sandbox: grace-period overrides are not modelled here.');
  const n = nodeArg(o_, pos[0], 'drain');
  const dry = flags.get('--dry-run');
  if (dry !== undefined && dry !== 'client') throw new CmdError(`sandbox: only --dry-run=client is modelled here.`);
  const sel = flags.get('--pod-selector');
  const onNode = [...o_.pods.values()].filter((p) => p.node === n.name && p.deleting === undefined && p.owner.kind !== 'Node' && (!sel || `app=${p.app}` === sel));
  const ds = onNode.filter((p) => p.owner.kind === 'DaemonSet');
  const bare = onNode.filter((p) => p.owner.kind === 'none');
  const lines: Out[] = [];
  const tag = dry ? ' (dry run)' : '';
  const already = n.unschedulable;
  if (!dry) n.unschedulable = true;
  lines.push(...o(`node/${n.name} ${already && !dry ? 'already cordoned' : 'cordoned'}${tag}`));
  ctx.seen(`drain-started:${n.name}`);
  const problems: string[] = [];
  if (bare.length && !flags.has('--force')) problems.push(`cannot delete Pods that declare no controller (use --force to override): ${bare.map((p) => `${p.ns}/${p.name}`).join(', ')}`);
  if (ds.length && !flags.has('--ignore-daemonsets')) problems.push(`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${ds.map((p) => `${p.ns}/${p.name}`).join(', ')}`);
  if (problems.length) {
    // kubectl drain tiltdev-worker / k8s-c-control-plane, without the flags
    const joined = problems.length > 1 ? `[${problems.join(', ')}]` : problems[0];
    return [...lines, ...e(`error: unable to drain node "${n.name}" due to error: ${joined}, continuing command...\nThere are pending nodes to be drained:\n ${n.name}\n${problems.join('\n')}`)];
  }
  const warn = [];
  if (bare.length) warn.push(`deleting Pods that declare no controller: ${bare.map((p) => `${p.ns}/${p.name}`).join(', ')}`);
  if (ds.length) warn.push(`ignoring DaemonSet-managed Pods: ${ds.map((p) => `${p.ns}/${p.name}`).join(', ')}`);
  if (warn.length) lines.push(...e(`Warning: ${warn.join('; ')}`));
  const targets = onNode.filter((p) => p.owner.kind !== 'DaemonSet');
  if (dry) {
    // The client-side dry run never calls the eviction API, so a budget that
    // would block the real drain does not show up here: it says "drained".
    for (const p of targets) lines.push(...o(`evicting pod ${p.ns}/${p.name} (dry run)`));
    lines.push(...o(`node/${n.name} drained (dry run)`));
    ctx.seen('dry-run-drained');
    return lines;
  }
  if (!targets.length) { lines.push(...o(`node/${n.name} drained`)); ctx.seen(`drained:${n.name}`); return lines; }
  const job: Job = { kind: 'drain', node: n.name, deadline: o_.tick + Math.ceil(secs / SECONDS_PER_TICK), next: o_.tick, selector: sel, onLine: () => {}, done: false };
  // Printed with Go's %v, as kubectl does: --timeout=60s reads "1m0s" in the error.
  (job as Job & { timeoutLabel?: string; pending: string[] }).timeoutLabel = Number.isFinite(secs) ? goDurationString(secs) : '';
  (job as Job & { pending: string[] }).pending = targets.map((p) => `${p.ns}/${p.name}`);
  ctx.jobs.push(job);
  lines.push(...drainAttempt(ctx, job));
  if (!job.done) lines.push(note(timeout ? `(drain keeps retrying every 5s until it finishes or ${timeout} pass. Type anything to stop it, like Ctrl+C.)` : '(drain keeps retrying every 5s, for ever with no --timeout. Type anything to stop it, like Ctrl+C.)'));
  return lines;
}

/** One pass of the eviction loop: evict what the budgets allow, report the rest. */
export function drainAttempt(ctx: Ctx, job: Job): Out[] {
  const o_ = ctx.ops;
  const j = job as Job & { pending: string[]; timeoutLabel?: string };
  const lines: Out[] = [];
  if (o_.tick >= job.deadline && job.next !== -1) {
    const left = j.pending;
    const errs = left.map((k) => { const [ns, name] = k.split('/'); return `error when evicting pods/"${name}" -n "${ns}": global timeout reached: ${j.timeoutLabel}`; });
    const joined = errs.length > 1 ? `[${errs.join(', ')}]` : errs[0];
    lines.push(...e(`There are pending pods in node "${job.node}" when an error occurred: ${joined}`));
    lines.push(...o(left.map((k) => `pod/${k.split('/')[1]}`).join('\n')));
    lines.push(...e(`error: unable to drain node "${job.node}" due to error: ${joined}, continuing command...\nThere are pending nodes to be drained:\n ${job.node}\n${errs.join('\n')}`));
    job.done = true; job.ok = false;
    ctx.seen('drain-timed-out');
    return lines;
  }
  if (o_.tick < job.next) return lines;
  job.next = o_.tick + 1;
  const still: string[] = [];
  for (const key of j.pending) {
    const p = o_.pods.get(key);
    if (!p) continue;
    if (p.deleting !== undefined) { still.push(key); continue; }
    lines.push(...o(`evicting pod ${key}`));
    if (o_.api() !== 'ok') { still.push(key); continue; }
    const budget = [...o_.pdbs.values()].find((b) => b.ns === p.ns && b.app === p.app);
    if (budget && budget.status.allowed <= 0) {
      // kubectl drain, with a PodDisruptionBudget at ALLOWED DISRUPTIONS 0 (the API's 429)
      lines.push(...e(`error when evicting pods/"${p.name}" -n "${p.ns}" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.`));
      ctx.seen('drain-blocked');
      still.push(key);
      continue;
    }
    if (budget) budget.status.allowed--;
    o_.deletePod(p);
    lines.push(...o(`pod/${p.name} evicted`));
    still.push(key);
  }
  // A pod counts as gone once the kubelet has removed it.
  j.pending = still.filter((k) => o_.pods.has(k));
  if (!j.pending.length) {
    lines.push(...o(`node/${job.node} drained`));
    job.done = true; job.ok = true;
    ctx.seen(`drained:${job.node}`);
  }
  return lines;
}

/** Called by the widget every tick, and by the terminal when the learner interrupts. */
export function tickJobs(ctx: Ctx): Out[] {
  const outp: Out[] = [];
  for (const j of ctx.jobs) if (!j.done) outp.push(...drainAttempt(ctx, j));
  ctx.jobs.splice(0, ctx.jobs.length, ...ctx.jobs.filter((j) => !j.done));
  return outp;
}

export function interrupt(ctx: Ctx): Out[] {
  if (!ctx.jobs.length) return [];
  ctx.jobs.length = 0;
  return o('^C');
}

// ---- etcd --------------------------------------------------------------------

const ETCD_FLAGS = ['--endpoints=https://127.0.0.1:2379', '--cacert=/etc/kubernetes/pki/etcd/ca.crt', '--cert=/etc/kubernetes/pki/etcd/server.crt', '--key=/etc/kubernetes/pki/etcd/server.key'];
const memberId = (i: number) => ['e58c878e0e01014', '2c6a7d3f9b1e8a05', '9f3b6a1c4d2e7085'][i] ?? `${i}`;

function execEtcd(ctx: Ctx, args: string[], ns: string): Out[] {
  const o_ = ctx.ops;
  api(ctx);
  const dd = args.indexOf('--');
  if (dd < 0) throw new CmdError('error: you must specify at least one command for the container, after --');
  const podName = args.slice(0, dd).filter((a) => !/^-/.test(a))[0];
  const p = o_.pods.get(`${ns}/${podName}`);
  if (!p) throw new CmdError(`Error from server (NotFound): pods "${podName}" not found`);
  if (p.component !== 'etcd') throw new CmdError(`sandbox: exec is modelled only into the etcd pods here (kubectl -n kube-system exec etcd-<node> -- etcdctl ...).`);
  const node = o_.node(p.node!)!;
  const cmd = args.slice(dd + 1);
  if (cmd[0] === 'sh' || cmd[0] === 'bash') throw new CmdError(`error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec: OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd[0]}": executable file not found in $PATH`);
  if (cmd[0] === 'etcdutl') return etcdutl(ctx, node, cmd.slice(1));
  if (cmd[0] !== 'etcdctl') throw new CmdError(`sandbox: the etcd image has etcdctl and etcdutl (and no shell). "${cmd[0]}" is not modelled.`);
  const rest = cmd.slice(1).filter((a) => !ETCD_FLAGS.includes(a));
  const tls = cmd.slice(1).filter((a) => ETCD_FLAGS.includes(a)).length;
  if (rest[0] === 'snapshot' && rest[1] !== 'save') {
    // etcdctl 3.6.8 on tiltdev: `snapshot status <file>` and `snapshot restore
    // <file>` print the snapshot help and exit 0 (the file is a positional
    // argument, so nothing is "unknown"). Only a flag the snapshot command lacks,
    // like --data-dir, adds the error and exit code 1.
    const flag = rest.slice(1).find((a) => a.startsWith('-'));
    if (!flag) return o(ETCDCTL_SNAPSHOT_HELP);
    return [...o(ETCDCTL_SNAPSHOT_HELP), ...e(`Error: unknown flag: ${flag.replace(/=.*$/, '')}`), ...e('command terminated with exit code 1')];
  }
  if (tls < 4) throw new CmdError('{"level":"warn","msg":"retrying of unary invoker failed","error":"rpc error: code = DeadlineExceeded desc = context deadline exceeded"}\nError: context deadline exceeded\ncommand terminated with exit code 1\n(sandbox: etcd only answers clients with the certificates; pass all four flags: ' + ETCD_FLAGS.join(' ') + ')');
  const wout = rest.includes('-w') ? rest[rest.indexOf('-w') + 1] : rest.find((a) => a.startsWith('--write-out='))?.slice(12);
  const words = rest.filter((a, i) => a !== '-w' && rest[i - 1] !== '-w' && !a.startsWith('--write-out'));
  if (words[0] === 'member' && words[1] === 'list') {
    ctx.seen('etcd-member-list');
    const rows = o_.etcdMembers().map((m, i) => {
      const restored = o_.restoredFor() && i === 0;
      return [restored ? '8e9e05c52164694d' : memberId(i), 'started', m.name, restored ? 'http://localhost:2380' : `https://172.18.0.${i + 2}:2380`, `https://172.18.0.${i + 2}:2379`, 'false'];
    });
    if (wout !== 'table') return o(rows.map((r) => r.join(', ')).join('\n'));
    return o(asciiTable(['ID', 'STATUS', 'NAME', 'PEER ADDRS', 'CLIENT ADDRS', 'IS LEARNER'], rows));
  }
  if (words[0] === 'snapshot' && words[1] === 'save') {
    const path = words[2];
    if (!path) throw new CmdError('Error: snapshot save expects one argument\ncommand terminated with exit code 1');
    if (!path.startsWith('/var/lib/etcd/')) throw new CmdError(`sandbox: write the snapshot under /var/lib/etcd/, the one directory the etcd pod shares with the node (a path elsewhere in the container is lost with it).`);
    o_.snapshots = o_.snapshots.filter((s) => s.path !== path);
    o_.snapshots.push({ path, node: node.name, revision: o_.etcdRevision, namespaces: [...o_.namespaces.keys()], pods: [...o_.pods.keys()], nsCreated: [...o_.namespaces] });
    ctx.seen('etcd-snapshot');
    // etcdctl snapshot save, etcd 3.6.8 (its JSON log lines shortened to their messages)
    return o([`{"level":"info","msg":"created temporary db file","path":"${path}.part"}`, '{"level":"info","logger":"client","msg":"opened snapshot stream; downloading"}', '{"level":"info","msg":"fetching snapshot","endpoint":"https://127.0.0.1:2379"}',
      '{"level":"info","logger":"client","msg":"completed snapshot read; closing"}', '{"level":"info","msg":"fetched snapshot","endpoint":"https://127.0.0.1:2379","size":"4.0 MB","etcd-version":"3.6.0"}', `{"level":"info","msg":"saved","path":"${path}"}`,
      `Snapshot saved at ${path}`, 'Server version 3.6.0'].join('\n'));
  }
  throw new CmdError(`sandbox: etcdctl ${words.join(' ')} is not modelled. member list -w table and snapshot save <path> are.`);
}

function etcdutl(ctx: Ctx, node: Node, args: string[]): Out[] {
  const o_ = ctx.ops;
  const { pos, flags } = parseFlags(args, new Set(['--data-dir', '--write-out', '-w']), new Set(['--data-dir', '--write-out', '-w']));
  const snap = (p: string | undefined) => { const s = o_.snapshots.find((x) => x.path === p && x.node === node.name); if (!s) throw new CmdError(`Error: stat ${p}: no such file or directory\ncommand terminated with exit code 1`); return s; };
  if (pos[0] === 'snapshot' && pos[1] === 'status') {
    const s = snap(pos[2]);
    return o(asciiTable(['HASH', 'REVISION', 'TOTAL KEYS', 'TOTAL SIZE', 'VERSION'], [['1e0c857d', String(s.revision), '573', '4.0 MB', '3.6.0']]));
  }
  if (pos[0] === 'snapshot' && pos[1] === 'restore') {
    const s = snap(pos[2]);
    const dir = flags.get('--data-dir');
    if (!dir) throw new CmdError('sandbox: give the restore its own new directory: --data-dir /var/lib/etcd/restored');
    // etcdutl snapshot restore into a directory that already existed
    if (dir === '/var/lib/etcd' || o_.restoredDirs.has(dir)) throw new CmdError(`Error: data-dir "${dir}" not empty or could not be read\ncommand terminated with exit code 1`);
    if (!dir.startsWith('/var/lib/etcd/')) throw new CmdError('sandbox: restore under /var/lib/etcd/ so the directory is on the node, where the etcd manifest can point at it.');
    o_.restoredDirs.set(dir, s);
    ctx.seen('etcd-restored');
    return o([`info\tsnapshot/v3_snapshot.go:305\trestoring snapshot\t{"path": "${s.path}", "wal-dir": "${dir}/member/wal", "data-dir": "${dir}", "snap-dir": "${dir}/member/snap"}`,
      'info\tschema/membership.go:138\tTrimming membership information from the backend...',
      'info\tmembership/cluster.go:424\tadded member\t{"cluster-id": "cdf818194e3a8c32", "local-member-id": "0", "added-peer-id": "8e9e05c52164694d", "added-peer-peer-urls": ["http://localhost:2380"], "added-peer-is-learner": false}',
      `info\tsnapshot/v3_snapshot.go:333\trestored snapshot\t{"path": "${s.path}", "wal-dir": "${dir}/member/wal", "data-dir": "${dir}", "snap-dir": "${dir}/member/snap"}`].join('\n'));
  }
  throw new CmdError('sandbox: etcdutl snapshot status <file> and etcdutl snapshot restore <file> --data-dir <dir> are modelled.');
}

function asciiTable(head: string[], rows: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)) + 2);
  const line = '+' + w.map((x) => '-'.repeat(x)).join('+') + '+';
  const center = (s: string, n: number) => { const l = Math.floor((n - s.length) / 2); return ' '.repeat(l) + s + ' '.repeat(n - s.length - l); };
  const right = (s: string, n: number, i: number) => i === 0 || /^(STATUS|NAME|PEER|CLIENT|HASH)/.test(head[i]) ? ` ${s.padEnd(n - 2)} ` : ` ${s.padStart(n - 2)} `;
  return [line, '|' + head.map((h, i) => center(h, w[i])).join('|') + '|', line, ...rows.map((r) => '|' + r.map((c, i) => right(c, w[i], i)).join('|') + '|'), line].join('\n');
}

// etcdctl 3.6.8 has only `snapshot save`; status and restore moved to etcdutl.
// This is the head of what it printed for `etcdctl snapshot restore` (then the global options).
const ETCDCTL_SNAPSHOT_HELP = `NAME:
  snapshot - Manages etcd node snapshots

USAGE:
  etcdctl snapshot <subcommand> [flags]

API VERSION:
  3.6

COMMANDS:
  save	Stores an etcd node backend snapshot to a given file
  (examples and global options trimmed by the sandbox)`;

// ---- the node: docker exec / docker cp ---------------------------------------------

function docker(ctx: Ctx, args: string[]): Out[] {
  const o_ = ctx.ops;
  if (args[0] === 'cp') {
    const [src, dst] = args.slice(1);
    const f = o_.hostFiles.get(src ?? '');
    if (!f) throw new CmdError(`lstat ${src ?? ''}: no such file or directory`);
    const m = /^([\w-]+):(.+)$/.exec(dst ?? '');
    const n = m ? o_.node(m[1]) : undefined;
    if (!m || !n) throw new CmdError(`Error response from daemon: No such container: ${m?.[1] ?? dst ?? ''}`);
    if (m[2] !== `/usr/bin/${f.what}`) throw new CmdError(`sandbox: copy ${f.what} to /usr/bin/${f.what}, where the node runs it from.`);
    if (f.what === 'kubeadm') n.kubeadm = f.version;
    else {
      n.kubeletBinary = f.version;
      const workload = [...o_.pods.values()].some((p) => p.node === n.name && p.deleting === undefined && p.owner.kind !== 'DaemonSet' && p.owner.kind !== 'Node');
      n.drainedWhenReplaced = n.unschedulable && !workload;
    }
    ctx.seen(`cp:${f.what}:${n.name}:${f.version}`);
    return [];
  }
  if (args[0] !== 'exec') throw new CmdError('sandbox: docker exec <node> <command> and docker cp <file> <node>:<path> are modelled here.');
  // Only docker's own -it before the container name; sed -i after it is sed's.
  const rest = args.slice(1);
  while (rest.length && /^-(it|ti|i|t)$/.test(rest[0])) rest.shift();
  const n = o_.node(rest[0] ?? '');
  if (!n) throw new CmdError(`Error response from daemon: No such container: ${rest[0] ?? ''}`);
  const cmd = rest.slice(1);
  switch (cmd[0]) {
    case 'ls': {
      const dir = (cmd[1] ?? '/').replace(/\/$/, '');
      if (dir === '/etc/kubernetes/manifests') { ctx.seen(`ls-manifests:${n.name}:${[...n.manifests].sort().join(',')}`); return o([...n.manifests].sort().join('\n')); }
      if (dir === '/tmp') return o([...n.tmp].sort().join('\n'));
      if (dir === '/var/lib/etcd' && n.controlPlane) return o(['member', ...o_.snapshots.filter((s) => s.node === n.name).map((s) => s.path.slice(14)), ...[...o_.restoredDirs.keys()].map((d) => d.slice(14))].sort().join('\n'));
      throw new CmdError(`sandbox: ls is modelled for /etc/kubernetes/manifests, /tmp and /var/lib/etcd on the node.`);
    }
    case 'mv': {
      const [src, dst] = cmd.slice(1);
      const file = (p: string) => p.split('/').pop()!;
      const dirOf = (p: string) => p.endsWith('/') ? p.replace(/\/$/, '') : p.slice(0, p.lastIndexOf('/'));
      const from = dirOf(src ?? ''), to = dst?.endsWith('/') || dst === '/tmp' || dst === '/etc/kubernetes/manifests' ? dst.replace(/\/$/, '') : dirOf(dst ?? '');
      const name = file(src ?? '');
      const box = (d: string) => d === '/etc/kubernetes/manifests' ? n.manifests : d === '/tmp' ? n.tmp : null;
      const a = box(from), b = box(to);
      if (!a || !b) throw new CmdError('sandbox: mv is modelled between /etc/kubernetes/manifests and /tmp on the node.');
      if (!a.has(name)) throw new CmdError(`mv: cannot stat '${src}': No such file or directory`);
      a.delete(name); b.add(name);
      ctx.seen(`mv:${name}:${to}`);
      return [];
    }
    case 'systemctl': return systemctl(ctx, n, cmd.slice(1));
    case 'journalctl': {
      if (!cmd.includes('kubelet')) throw new CmdError('sandbox: journalctl -u kubelet is the log modelled here.');
      ctx.seen(`journal:${n.name}:${n.kubelet.running}`);
      const tail = n.journal.slice(-12);
      return o(tail.length ? tail.join('\n') : `${fmtJournal(o_)} ${n.name} kubelet[258]: I1103 06:00:00.000000     258 kubelet_node_status.go:75] "Successfully registered node" node="${n.name}"`);
    }
    case 'crictl': {
      if (cmd[1] !== 'ps') throw new CmdError('sandbox: crictl ps is modelled here.');
      const rows = [...n.containers].map((c, i) => [(0xb5613d8fa87d2 + i * 977).toString(16).slice(0, 13), ['315157c5c4d76', 'ee85eb1f0edd2', 'c2616bc3c6956', 'b665198f31ae0'][COMPONENTS.indexOf(c)], 'About an hour ago', 'Running', c, '0', 'd2364ebcb0bef', `${c}-${n.name}`, 'kube-system']);
      for (const p of o_.pods.values()) if (p.node === n.name && p.owner.kind !== 'Node' && (p.status === 'Running' || p.status === 'Terminating')) rows.push(['4d150384149c5', '38667dd9be96c', 'About an hour ago', 'Running', p.owner.kind === 'DaemonSet' ? `${p.app}${p.app === 'kindnet' ? '-cni' : ''}` : p.app, '0', '3eb451b4553a4', p.name, p.ns]);
      ctx.seen(`crictl:${n.name}`);
      return o(table([['CONTAINER', 'IMAGE', 'CREATED', 'STATE', 'NAME', 'ATTEMPT', 'POD ID', 'POD', 'NAMESPACE'], ...rows]));
    }
    case 'kubeadm': return kubeadm(ctx, n, cmd.slice(1));
    case 'sed': return sed(ctx, n, cmd.slice(1));
    case 'cat': throw new CmdError('sandbox: the manifests\' contents are not modelled; ls and mv them, or sed the etcd data path.');
    default: throw new CmdError(`sandbox: on the node, this sandbox runs ls, mv, systemctl, journalctl, crictl, kubeadm and sed. "${cmd[0] ?? ''}" is not one of them.`);
  }
}

const fmtJournal = (o_: Ops) => {
  const d = new Date(Date.UTC(2026, 10, 3, 6, 0, 0) + o_.seconds * 1000);
  return `Nov 03 ${d.toISOString().slice(11, 19)}`;
};

function systemctl(ctx: Ctx, n: Node, args: string[]): Out[] {
  const o_ = ctx.ops;
  const [verb, unit] = args;
  if (verb === 'daemon-reload') return [];
  if (unit !== 'kubelet' && unit !== 'kubelet.service') throw new CmdError('sandbox: systemctl is modelled for the kubelet only.');
  const j = (l: string) => n.journal.push(`${fmtJournal(o_)} ${n.name} systemd[1]: ${l}`);
  const start = () => {
    n.kubelet = { running: true, version: n.kubeletBinary };
    j('Starting kubelet.service - kubelet: The Kubernetes Node Agent...');
    n.journal.push(`${fmtJournal(o_)} ${n.name} kubelet[${700 + o_.tick}]: I1103 ${fmtJournal(o_).slice(7)}.267401 ${700 + o_.tick} server.go:1285] "Started kubelet"`);
    j('Started kubelet.service - kubelet: The Kubernetes Node Agent.');
  };
  // The journal lines are systemd 257's, as a kind node printed them around a
  // kubelet stop and start (the Starting line precedes Started).
  const stop = () => {
    if (!n.kubelet.running) return;
    n.kubelet = { ...n.kubelet, running: false };
    j('Stopping kubelet.service - kubelet: The Kubernetes Node Agent...');
    j('kubelet.service: Deactivated successfully.');
    j('Stopped kubelet.service - kubelet: The Kubernetes Node Agent.');
    j('kubelet.service: Consumed 5.536s CPU time, 41.6M memory peak.');
  };
  // The sandbox's kubelet, on its first sync, removes the pods the API evicted
  // while it was down (ops.ts). That is the documented behaviour; our real
  // restarted kubelet failed (inotify), so it was never watched, and the
  // screen says so where it happens.
  const cleanup = (): Out[] => [...o_.pods.values()].some((p) => p.node === n.name && p.deleting === Infinity)
    ? [note('(sandbox: when this kubelet syncs, it stops the evicted pods it still runs and they leave the API. That is the documented behaviour; we could not watch it for real, because our restarted kubelet failed.)')] : [];
  if (verb === 'stop') { stop(); ctx.seen(`kubelet-stopped:${n.name}`); return []; }
  if (verb === 'start') { const was = n.kubelet.running; if (!was) start(); ctx.seen(`kubelet-started:${n.name}`); return was ? [] : cleanup(); }
  if (verb === 'restart') { stop(); start(); ctx.seen(`kubelet-started:${n.name}`); return cleanup(); }
  if (verb === 'status' || verb === 'is-active') {
    if (verb === 'is-active') return o(n.kubelet.running ? 'active' : 'inactive');
    // systemctl status kubelet on a kind node (first lines)
    return o(['● kubelet.service - kubelet: The Kubernetes Node Agent', '     Loaded: loaded (/etc/systemd/system/kubelet.service; enabled; preset: enabled)', '    Drop-In: /etc/systemd/system/kubelet.service.d', '             └─10-kubeadm.conf, 11-kind.conf',
      `     Active: ${n.kubelet.running ? 'active (running)' : 'inactive (dead)'}`, '       Docs: http://kubernetes.io/docs/'].join('\n'));
  }
  throw new CmdError(`sandbox: systemctl ${verb ?? ''} is not modelled; stop, start, restart, status and daemon-reload are.`);
}

function sed(ctx: Ctx, n: Node, args: string[]): Out[] {
  // Only the one edit the etcd restore needs: point the etcd-data hostPath at the restored directory.
  const expr = args[1] ?? '';
  const parts = expr.startsWith('s') && expr.length > 2 ? expr.slice(2).split(expr[1]) : [];
  const dest = parts.length === 3 && parts[2] === '' && (parts[0] === 'path: /var/lib/etcd$' || parts[0] === 'path: /var/lib/etcd') ? /^path: (\/var\/lib\/etcd\/[\w.-]+)$/.exec(parts[1]) : null;
  const m = args[0] === '-i' && args[2] === '/etc/kubernetes/manifests/etcd.yaml' && dest ? [expr, '', '', dest[1]] : null;
  if (!m) throw new CmdError("sandbox: sed is modelled for one edit only: docker exec <node> sed -i 's#path: /var/lib/etcd$#path: /var/lib/etcd/restored#' /etc/kubernetes/manifests/etcd.yaml");
  if (!n.manifests.has('etcd.yaml')) throw new CmdError("sed: can't read /etc/kubernetes/manifests/etcd.yaml: No such file or directory");
  if (n.etcdDataDir !== '/var/lib/etcd') return [];
  n.etcdDataDir = m[3];
  // The kubelet sees a changed manifest and restarts etcd on the new directory.
  n.containers.delete('etcd');
  ctx.seen('etcd-manifest-pointed');
  return [];
}

// ---- kubeadm -----------------------------------------------------------------

function kubeadm(ctx: Ctx, n: Node, args: string[]): Out[] {
  const o_ = ctx.ops;
  // kubeadm version prints a long Go struct; the sandbox keeps the fields that matter and says so.
  if (args[0] === 'version') return o(args.includes('-o') || args.some((a) => a.startsWith('-o')) ? n.kubeadm : `kubeadm version: &version.Info{Major:"1", Minor:"${ver(n.kubeadm).minor}", ..., GitVersion:"${n.kubeadm}", ..., Platform:"linux/amd64"}  (fields trimmed by the sandbox)`);
  if (args[0] !== 'upgrade') throw new CmdError('sandbox: kubeadm version and kubeadm upgrade plan|apply|node are modelled here.');
  if (o_.api() !== 'ok') throw new CmdError('error: [upgrade/init config] unable to fetch the kubeadm-config ConfigMap: ' + API_DOWN);
  const cluster = o_.nodes.find((x) => x.controlPlane)!.componentVersion;
  const kv = ver(n.kubeadm), cv = ver(cluster);
  const sub = args[1];
  const reading = ['[upgrade/config] Reading configuration from the "kubeadm-config" ConfigMap in namespace "kube-system"...', "[upgrade/config] Use 'kubeadm init phase upload-config kubeadm --config your-config-file' to re-upload it."];
  // kubeadm 1.37.2 against a 1.35.0 control plane: plan and apply both stop here.
  if (kv.minor - cv.minor > 1) {
    ctx.seen('kubeadm-refused-skip');
    const tag = sub === 'plan' ? '[upgrade/init config] FATAL' : '[upgrade] FATAL';
    return [...o((sub === 'plan' ? ['[preflight] Running pre-flight checks.', ...reading] : reading.map((l) => l.replace('[upgrade/config]', '[upgrade]'))).join('\n')),
      ...e(`error: ${tag}: this version of kubeadm only supports deploying clusters with the control plane version >= 1.${kv.minor - 1}.0. Current version: ${cluster}\nTo see the stack trace of this error execute with --v=5 or higher`)];
  }
  if (sub === 'plan') {
    if (!n.controlPlane) throw new CmdError('sandbox: run kubeadm upgrade plan on a control-plane node.');
    ctx.seen('kubeadm-plan');
    const target = `v1.${kv.minor}.${kv.minor === 36 ? 6 : 2}`;
    const cps = o_.nodes.filter((x) => x.controlPlane);
    return o([...reading, '[upgrade/versions] Cluster version: ' + cluster.replace(/^v/, ''), `[upgrade/versions] kubeadm version: ${n.kubeadm}`, `[upgrade/versions] Target version: ${target}`, '',
      "Components that must be upgraded manually after you have upgraded the control plane with 'kubeadm upgrade apply':",
      table([['COMPONENT', 'NODE', 'CURRENT', 'TARGET'], ...o_.nodes.map((x) => ['kubelet', x.name, x.kubelet.version, target])]), '',
      'Upgrade to the latest stable version:', '',
      table([['COMPONENT', 'NODE', 'CURRENT', 'TARGET'], ...cps.flatMap((x) => ['kube-apiserver', 'kube-controller-manager', 'kube-scheduler'].map((c) => [c, x.name, x.componentVersion, target]))]), '',
      'You can now apply the upgrade by executing the following command:', '', `\tkubeadm upgrade apply ${target}`, '', `Note: Before you can perform this upgrade, you have to update kubeadm to ${target}.`].join('\n'));
  }
  if (sub === 'apply') {
    if (!n.controlPlane) throw new CmdError('sandbox: kubeadm upgrade apply runs on the first control-plane node; on the others, and on workers, use kubeadm upgrade node.');
    const target = args.find((a) => /^v?\d+\.\d+\.\d+$/.test(a));
    if (!target) throw new CmdError('error: the version argument is invalid: missing version, for example kubeadm upgrade apply v1.36.1');
    const tv = ver(target);
    // kubeadm 1.36.1 asked for v1.37.2 on a 1.36.1 cluster
    if (tv.minor > kv.minor) return e(`error: error execution phase preflight: the version argument is invalid due to these fatal errors:\n\n\t- Specified version to upgrade to "${target}" is at least one minor release higher than the kubeadm minor release (${tv.minor} > ${kv.minor}). Such an upgrade is not supported\n\nPlease fix the misalignments highlighted above and try upgrading again\nTo see the stack trace of this error execute with --v=5 or higher`);
    if (tv.minor < cv.minor) throw new CmdError('sandbox: downgrades are not modelled here.');
    if (`v${tv.major}.${tv.minor}.${tv.patch}` !== n.kubeadm) throw new CmdError(`sandbox: this sandbox only has the images for ${n.kubeadm}; upgrade to the version of the kubeadm on the node (kubeadm upgrade apply ${n.kubeadm}).`);
    if (!args.includes('-y') && !args.includes('--yes') && !args.includes('--dry-run')) throw new CmdError('[upgrade] Are you sure you want to proceed? [y/N]:\nsandbox: this terminal cannot answer prompts. Run it again with -y.');
    if (args.includes('--dry-run')) return o(`[dryrun] Finished dryrunning successfully!\n(sandbox: nothing changed; run without --dry-run and with -y to upgrade.)`);
    for (const x of o_.nodes.filter((y) => y.controlPlane)) x.componentVersion = n.kubeadm;
    o_.serverVersion = n.kubeadm;
    ctx.seen('control-plane-upgraded');
    // kubeadm upgrade apply v1.36.1 on a 1.35.0 kind control plane (selected lines; the real run took 210 s)
    return o([...reading.map((l) => l.replace('[upgrade/config]', '[upgrade]')), '[upgrade/preflight] Running preflight checks', '[upgrade] Running cluster health checks',
      `[upgrade/preflight] You have chosen to upgrade the cluster version to "${n.kubeadm}"`, `[upgrade/versions] Cluster version: ${cluster}`, `[upgrade/versions] kubeadm version: ${n.kubeadm}`,
      '[upgrade/preflight] Pulling images required for setting up a Kubernetes cluster', `[upgrade/control-plane] Upgrading your static Pod-hosted control plane to version "${n.kubeadm}" (timeout: 5m0s)...`,
      ...COMPONENTS.map((c) => `[upgrade/staticpods] Component "${c}" upgraded successfully!`),
      '[upgrade/kubelet-config] The kubelet configuration for this node was successfully upgraded!', '[addons] Applied essential addon: CoreDNS', '[addons] Applied essential addon: kube-proxy', '',
      `[upgrade] SUCCESS! A control plane node of your cluster was upgraded to "${n.kubeadm}".`, '', '[upgrade] Now please proceed with upgrading the rest of the nodes by following the right order.'].join('\n'));
  }
  if (sub === 'node') {
    if (ver(cluster).minor < kv.minor) throw new CmdError('sandbox: upgrade the control plane first (kubeadm upgrade apply on ops-control-plane). The docs\' order is control plane, then the other nodes.');
    // The docs' worker steps put the control plane's kubeadm on the node before
    // running it. What a different kubeadm prints here was never captured, so
    // the sandbox refuses in its own words rather than letting it "succeed"
    // (it used to, with v1.35.0 on the worker, and the mission then passed).
    if (n.kubeadm !== cluster) throw new CmdError(`sandbox: the kubeadm on ${n.name} is ${n.kubeadm} and the control plane is ${cluster}. The docs upgrade kubeadm on the node first: docker cp ${cluster}/kubeadm ${n.name}:/usr/bin/kubeadm. (What a mismatched kubeadm does here was not tested for this sandbox.)`);
    ctx.seen(`kubeadm-node:${n.name}`);
    // kubeadm upgrade node, as it printed on a kind control-plane node (1.36.1).
    // A worker was not available to run it on (no room for a second kind node
    // on that machine), so a worker's exact lines were not captured, and the
    // screen says so: a code comment alone is not a label.
    const label = n.controlPlane ? [] : [note('(sandbox: these lines were captured on a control-plane node; no worker run was captured. kubeadm\'s source says a worker also prints "[upgrade/preflight] Skipping prepull. Not a control plane node." and "[upgrade/control-plane] Skipping phase. Not a control plane node.")')];
    return [...o(['[upgrade] Backing up kubelet config file to /etc/kubernetes/tmp/kubeadm-kubelet-config-2026-11-03-06-51-14/config.yaml', '[patches] Applied patch of type "application/strategic-merge-patch+json" to target "kubeletconfiguration"',
      '[kubelet-start] Writing kubelet configuration to file "/var/lib/kubelet/config.yaml"', '[upgrade/kubelet-config] The kubelet configuration for this node was successfully upgraded!'].join('\n')), ...label];
  }
  throw new CmdError('sandbox: kubeadm upgrade plan, apply and node are modelled here.');
}

/** For the widget: every kubelet whose copied-in binary differs from the one running. */
export function pendingKubelets(o_: Ops) { return o_.nodes.filter((n) => n.kubeletBinary !== n.kubelet.version).map((n) => n.name); }
export type { Pod, Component };
