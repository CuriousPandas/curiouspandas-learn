// kubectl for the toy cluster. Commands and output columns follow the real
// tool closely enough that muscle memory transfers: a learner who types
// `kubectl describe pod` here should find the same Events table on a real one.

import { Cluster, SECONDS_PER_TICK, LIVENESS, type Pod } from './cluster.ts';
import { tokenize } from '../git/shell.ts';

export type Out = { text: string; kind: 'out' | 'err' };
export type Observer = (cmd: { verb: string; kind?: string; name?: string; pod?: Pod }) => void;

const age = (c: Cluster, since: number) => {
  const s = (c.tick - since) * SECONDS_PER_TICK;
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
};

function table(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i] + 3))).join('')).join('\n');
}

const KINDS: Record<string, string> = {
  po: 'pods', pod: 'pods', pods: 'pods', deploy: 'deployments', deployment: 'deployments', deployments: 'deployments',
  rs: 'replicasets', replicaset: 'replicasets', replicasets: 'replicasets', no: 'nodes', node: 'nodes', nodes: 'nodes',
  ev: 'events', event: 'events', events: 'events', quota: 'resourcequotas', resourcequota: 'resourcequotas', resourcequotas: 'resourcequotas', all: 'all',
};

function parseCpu(v: string) {
  if (/^\d+m$/.test(v)) return parseInt(v, 10);
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  throw new Error(`error: invalid cpu quantity "${v}" (try 250m or 0.5)`);
}
function parseMem(v: string) {
  const m = /^(\d+)(Mi|Gi)$/.exec(v);
  if (!m) throw new Error(`error: invalid memory quantity "${v}" (try 64Mi or 1Gi)`);
  return parseInt(m[1], 10) * (m[2] === 'Gi' ? 1024 : 1);
}
const fmtMem = (n: number) => (n % 1024 === 0 ? `${n / 1024}Gi` : `${n}Mi`);

function flag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + '=')) return args[i].slice(name.length + 1);
  }
}

// Flags whose value is the next word. Without this list, `-p '{...}'` would be
// read as the resource name.
const VALUE_FLAGS = new Set(['--image', '--replicas', '--requests', '--limits', '-p', '--patch', '--type', '--hard', '-o']);

function positionals(args: string[]) {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) { if (VALUE_FLAGS.has(args[i])) i++; continue; }
    out.push(args[i]);
  }
  return out;
}

/** "deployment/hello", "deploy hello" and "hello" (when the kind is implied) all name the same thing. */
function target(args: string[], impliedKind?: string): { kind: string; name: string } {
  const pos = positionals(args);
  if (pos[0]?.includes('/')) { const [k, n] = pos[0].split('/'); return { kind: KINDS[k] ?? k, name: n }; }
  if (impliedKind && pos.length === 1) return { kind: impliedKind, name: pos[0] };
  return { kind: KINDS[pos[0]] ?? pos[0], name: pos[1] };
}

export function kubectl(c: Cluster, line: string, observe?: Observer): Out[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const argv = tokenize(trimmed);
    if (argv[0] === 'help') return lines(HELP);
    if (argv[0] === 'clear') return [];
    if (argv[0] !== 'kubectl' && argv[0] !== 'k') throw new Error(`${argv[0]}: command not found (this terminal speaks kubectl - type help)`);
    return lines(run(c, argv.slice(1), observe));
  } catch (e) {
    return lines((e as Error).message, 'err');
  }
}

function lines(text: string, kind: Out['kind'] = 'out'): Out[] {
  return text ? text.split('\n').map((t) => ({ text: t, kind })) : [];
}

export const HELP = `kubectl get pods | deploy | rs | nodes | events | quota | all   (-o wide)
kubectl describe pod <name> | deploy <name> | node <name> | quota <name>
kubectl logs <pod> [--previous]
kubectl create deployment <name> --image=<image> [--replicas=N]
kubectl scale deployment/<name> --replicas=N
kubectl set image deployment/<name> app=<image>
kubectl set resources deployment/<name> --requests=cpu=250m,memory=64Mi --limits=memory=256Mi
kubectl set env deployment/<name> KEY=value
kubectl patch deployment/<name> -p '<json>'      kubectl patch quota/<name> -p '<json>'
kubectl create quota <name> --hard=pods=N
kubectl rollout status deployment/<name>   kubectl rollout undo deployment/<name>
kubectl delete pod <name> | deployment <name> | quota <name>
Images: panda/hello:1.0  panda/hello:2.0  panda/greedy:1.0  panda/slowpoke:1.0  panda/needs-config:1.0`;

function podStatus(c: Cluster, p: Pod) {
  if (p.status === 'CrashLoopBackOff' && p.last && c.tick - p.last.at < 1) return p.last.reason;
  return p.status;
}

function run(c: Cluster, args: string[], observe?: Observer): string {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'get': return get(c, rest, observe);
    case 'describe': return describe(c, rest, observe);
    case 'logs': {
      const name = rest.find((a) => !a.startsWith('-'));
      const p = name && c.pods.get(name);
      if (!p) throw new Error(`error: pod "${name ?? ''}" not found (copy a name from kubectl get pods)`);
      observe?.({ verb: 'logs', kind: 'pods', name: p.name, pod: p });
      if (rest.includes('--previous') || rest.includes('-p')) {
        if (!p.last) throw new Error(`Error from server (BadRequest): previous terminated container "app" in pod "${p.name}" not found`);
        return p.previousLogs.join('\n');
      }
      if (p.status === 'Pending' || p.status === 'ContainerCreating') throw new Error(`Error from server (BadRequest): container "app" in pod "${p.name}" is waiting to start: ${p.status}`);
      return p.logs.join('\n');
    }
    case 'create': {
      const [what, name] = rest.filter((a) => !a.startsWith('-'));
      if (what === 'deployment' || what === 'deploy') {
        const image = flag(rest, '--image');
        if (!name || !image) throw new Error('error: required flag(s) "image" not set\nusage: kubectl create deployment <name> --image=<image> [--replicas=N]');
        c.createDeployment(name, image, Number(flag(rest, '--replicas') ?? 1));
        return `deployment.apps/${name} created`;
      }
      if (what === 'quota' || what === 'resourcequota') {
        const hard = flag(rest, '--hard');
        const m = hard && /^pods=(\d+)$/.exec(hard);
        if (!name || !m) throw new Error('error: this sandbox supports kubectl create quota <name> --hard=pods=N');
        if (c.quota) throw new Error(`Error from server (AlreadyExists): resourcequotas "${c.quota.name}" already exists`);
        c.quota = { name, pods: Number(m[1]) };
        return `resourcequota/${name} created`;
      }
      throw new Error(`error: unknown resource "${what}" for create (try deployment or quota)`);
    }
    case 'scale': {
      const t = target(rest);
      const n = flag(rest, '--replicas');
      if (t.kind !== 'deployments' || n === undefined) throw new Error('error: usage: kubectl scale deployment/<name> --replicas=N');
      c.deployment(t.name).replicas = Math.max(0, Number(n));
      return `deployment.apps/${t.name} scaled`;
    }
    case 'set': return set(c, rest);
    case 'patch': {
      const t = target(rest);
      const raw = flag(rest, '-p') ?? flag(rest, '--patch');
      if (!raw) throw new Error(`error: must specify -p '<json>'`);
      let body: any;
      try { body = JSON.parse(raw); } catch { throw new Error('error: unable to parse the patch: it is not valid JSON (wrap it in single quotes)'); }
      if (t.kind === 'resourcequotas') {
        if (!c.quota || c.quota.name !== t.name) throw new Error(`Error from server (NotFound): resourcequotas "${t.name}" not found`);
        const pods = body?.spec?.hard?.pods;
        if (pods === undefined) return `resourcequota/${t.name} patched (no change)`;
        c.quota.pods = Number(pods);
        return `resourcequota/${t.name} patched`;
      }
      if (t.kind !== 'deployments') throw new Error(`error: this sandbox patches deployments and quotas only`);
      const ctr = body?.spec?.template?.spec?.containers?.[0];
      if (!ctr && body?.spec?.replicas === undefined) throw new Error('error: patch has nothing this sandbox understands (spec.replicas or spec.template.spec.containers[0])');
      if (body?.spec?.replicas !== undefined) c.deployment(t.name).replicas = Number(body.spec.replicas);
      const changed = !ctr || c.updateTemplate(t.name, (tpl) => {
        if (ctr.image) tpl.image = ctr.image;
        // Unset fields take the API defaults, so a bare probe is as short here
        // as it is on a real cluster.
        if (ctr.startupProbe !== undefined) tpl.startupProbe = ctr.startupProbe === null ? false : {
          initialDelaySeconds: Number(ctr.startupProbe.initialDelaySeconds ?? 0),
          periodSeconds: Number(ctr.startupProbe.periodSeconds ?? 10),
          failureThreshold: Number(ctr.startupProbe.failureThreshold ?? 3),
        };
        if (ctr.livenessProbe !== undefined) tpl.liveness = ctr.livenessProbe !== null;
        if (ctr.resources?.limits?.memory) tpl.limits.mem = parseMem(ctr.resources.limits.memory);
        if (ctr.resources?.requests?.memory) tpl.requests.mem = parseMem(ctr.resources.requests.memory);
        if (ctr.resources?.requests?.cpu) tpl.requests.cpu = parseCpu(String(ctr.resources.requests.cpu));
      });
      return `deployment.apps/${t.name} patched${changed ? '' : ' (no change)'}`;
    }
    case 'rollout': {
      const [sub] = rest;
      const t = target(rest.slice(1));
      const d = c.deployment(t.name);
      if (sub === 'status') {
        const s = c.deploymentStatus(t.name);
        // The same three waiting messages, in the same order, as kubectl's own
        // rollout status: a stuck new pod reads "new replicas have been
        // updated", which is the line the Deployment docs show for a bad tag.
        if (s.upToDate < s.desired) return `Waiting for deployment "${t.name}" rollout to finish: ${s.upToDate} out of ${s.desired} new replicas have been updated...`;
        if (s.current > s.upToDate) return `Waiting for deployment "${t.name}" rollout to finish: ${s.current - s.upToDate} old replicas are pending termination...`;
        if (s.available < s.upToDate) return `Waiting for deployment "${t.name}" rollout to finish: ${s.available} of ${s.upToDate} updated replicas are available...`;
        return `deployment "${t.name}" successfully rolled out`;
      }
      if (sub === 'undo') {
        const prev = d.history.pop();
        if (!prev) throw new Error(`error: no rollout history found for deployment "${t.name}"`);
        d.template = prev;
        return `deployment.apps/${t.name} rolled back`;
      }
      throw new Error('error: try kubectl rollout status|undo deployment/<name>');
    }
    case 'delete': {
      const t = target(rest);
      if (t.kind === 'pods') { c.deletePod(t.name); return `pod "${t.name}" deleted`; }
      if (t.kind === 'deployments') { c.deleteDeployment(t.name); return `deployment.apps "${t.name}" deleted`; }
      if (t.kind === 'resourcequotas') {
        if (!c.quota || c.quota.name !== t.name) throw new Error(`Error from server (NotFound): resourcequotas "${t.name}" not found`);
        c.quota = null;
        return `resourcequota "${t.name}" deleted`;
      }
      throw new Error(`error: the sandbox can delete pods, deployments and quotas`);
    }
    case 'apply': case 'edit': case 'exec': case 'port-forward':
      throw new Error(`kubectl ${verb}: real kubectl has this; this sandbox does not. Use set / patch / scale here, and try ${verb} on the tilt platform.`);
    default:
      throw new Error(`error: unknown command "${verb ?? ''}" for "kubectl" (type help)`);
  }
}

function set(c: Cluster, rest: string[]): string {
  const [what, ...more] = rest;
  const t = target(more, 'deployments');
  if (t.kind !== 'deployments') throw new Error('error: the sandbox can set fields on deployments only');
  c.deployment(t.name);
  if (what === 'image') {
    const pair = more.find((a) => a.includes('=') && !a.startsWith('-'));
    if (!pair) throw new Error('error: usage: kubectl set image deployment/<name> app=<image>');
    const image = pair.split('=')[1];
    c.updateTemplate(t.name, (tpl) => { tpl.image = image; });
    return `deployment.apps/${t.name} image updated`;
  }
  if (what === 'resources') {
    const req = flag(more, '--requests'), lim = flag(more, '--limits');
    if (!req && !lim) throw new Error('error: you must specify --requests and/or --limits');
    c.updateTemplate(t.name, (tpl) => {
      for (const [k, v] of (req ?? '').split(',').filter(Boolean).map((s) => s.split('='))) {
        if (k === 'cpu') tpl.requests.cpu = parseCpu(v); else if (k === 'memory') tpl.requests.mem = parseMem(v);
      }
      for (const [k, v] of (lim ?? '').split(',').filter(Boolean).map((s) => s.split('='))) {
        if (k === 'memory') tpl.limits.mem = parseMem(v);
      }
    });
    return `deployment.apps/${t.name} resource requirements updated`;
  }
  if (what === 'env') {
    const pairs = more.filter((a) => /^[A-Z_][A-Z0-9_]*=/.test(a));
    if (!pairs.length) throw new Error('error: usage: kubectl set env deployment/<name> KEY=value');
    c.updateTemplate(t.name, (tpl) => { for (const p of pairs) { const i = p.indexOf('='); tpl.env[p.slice(0, i)] = p.slice(i + 1); } });
    return `deployment.apps/${t.name} env updated`;
  }
  throw new Error('error: try kubectl set image | resources | env');
}

function get(c: Cluster, rest: string[], observe?: Observer): string {
  const t = target(rest);
  const wide = flag(rest, '-o') === 'wide';
  observe?.({ verb: 'get', kind: t.kind, name: t.name });
  const parts: string[] = [];
  const want = (k: string) => t.kind === k || t.kind === 'all';
  const asked = positionals(rest)[0]?.split('/')[0] ?? '';
  if (!KINDS[asked]) {
    throw new Error(`error: the server doesn't have a resource type "${asked}" (try pods, deploy, rs, nodes, events, quota)`);
  }
  if (want('pods')) {
    const pods = [...c.pods.values()].filter((p) => !t.name || p.name === t.name);
    if (!pods.length && t.kind === 'pods') return t.name ? `Error from server (NotFound): pods "${t.name}" not found` : 'No resources found in default namespace.';
    if (pods.length) {
      const head = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['NODE'] : [])];
      parts.push(table([head, ...pods.map((p) => [
        p.name, `${p.ready ? 1 : 0}/1`, podStatus(c, p),
        p.restarts && p.last ? `${p.restarts} (${age(c, p.last.at)} ago)` : String(p.restarts), age(c, p.created), ...(wide ? [p.node ?? '<none>'] : []),
      ])]));
    }
  }
  if (want('deployments')) {
    const ds = [...c.deployments.values()].filter((d) => !t.name || d.name === t.name);
    if (!ds.length && t.kind === 'deployments') return 'No resources found in default namespace.';
    if (ds.length) parts.push(table([['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE'], ...ds.map((d) => {
      const s = c.deploymentStatus(d.name);
      return [d.name, `${s.ready}/${s.desired}`, String(s.upToDate), String(s.available)];
    })]));
  }
  if (want('replicasets')) {
    const rs = [...c.replicasets.values()];
    if (!rs.length && t.kind === 'replicasets') return 'No resources found in default namespace.';
    if (rs.length) parts.push(table([['NAME', 'DESIRED', 'CURRENT', 'READY', ...(wide ? ['IMAGE'] : [])], ...rs.map((r) => {
      const live = c.live(r.name);
      return [r.name, String(r.replicas), String(live.length), String(live.filter((p) => p.ready).length), ...(wide ? [r.template.image] : [])];
    })]));
  }
  if (t.kind === 'nodes') {
    return table([['NAME', 'STATUS', 'CPU (requested/allocatable)', 'MEMORY (requested/allocatable)'], ...c.nodes.map((n) => {
      const u = c.used(n.name);
      return [n.name, 'Ready', `${u.cpu}m/${n.cpu}m`, `${fmtMem(u.mem)}/${fmtMem(n.mem)}`];
    })]);
  }
  if (t.kind === 'events') {
    if (!c.events.length) return 'No events found in default namespace.';
    return table([['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], ...c.events.slice(-25).map((e) => [age(c, e.tick), e.type, e.reason, e.object, e.message])]);
  }
  if (t.kind === 'resourcequotas') {
    if (!c.quota) return 'No resources found in default namespace.';
    const used = [...c.pods.values()].filter((p) => p.status !== 'Terminating').length;
    return table([['NAME', 'REQUEST'], [c.quota.name, `pods: ${used}/${c.quota.pods}`]]);
  }
  return parts.join('\n\n');
}

function describe(c: Cluster, rest: string[], observe?: Observer): string {
  const t = target(rest);
  if (t.kind === 'pods') {
    const p = c.pods.get(t.name);
    if (!p) throw new Error(`Error from server (NotFound): pods "${t.name ?? ''}" not found`);
    observe?.({ verb: 'describe', kind: 'pods', name: p.name, pod: p });
    const tpl = p.template;
    const st = podStatus(c, p);
    const state = p.status === 'Running' ? `Running\n      Started:      ${age(c, p.startedAt ?? 0)} ago`
      : `Waiting\n      Reason:       ${st === 'Pending' ? 'Pending' : p.status}`;
    const last = p.last ? `\n    Last State:     Terminated\n      Reason:       ${p.last.reason}\n      Exit Code:    ${p.last.exitCode}` : '';
    const env = Object.keys(tpl.env).length ? Object.entries(tpl.env).map(([k, v]) => `\n      ${k}:  ${v}`).join('') : ' <none>';
    const ev = c.events.filter((e) => e.object === `pod/${p.name}`);
    return `Name:             ${p.name}
Namespace:        default
Node:             ${p.node ?? '<none>'}
Status:           ${p.status === 'Pending' ? 'Pending' : p.status === 'Terminating' ? 'Terminating' : 'Running'}
Controlled By:    ReplicaSet/${p.owner}
Containers:
  app:
    Image:          ${tpl.image}
    State:          ${state}${last}
    Ready:          ${p.ready ? 'True' : 'False'}
    Restart Count:  ${p.restarts}
    Limits:
      memory:  ${fmtMem(tpl.limits.mem)}
    Requests:
      cpu:     ${tpl.requests.cpu}m
      memory:  ${fmtMem(tpl.requests.mem)}
    Liveness:   ${tpl.liveness ? `http-get http://:8080/ delay=${LIVENESS.initialDelaySeconds}s timeout=1s period=${LIVENESS.periodSeconds}s #success=1 #failure=${LIVENESS.failureThreshold}` : '<none>'}
    Startup:    ${tpl.startupProbe ? `http-get http://:8080/ delay=${tpl.startupProbe.initialDelaySeconds}s timeout=1s period=${tpl.startupProbe.periodSeconds}s #success=1 #failure=${tpl.startupProbe.failureThreshold}` : '<none>'}
    Environment:${env}
Events:
${ev.length ? table([['  Type', 'Reason', 'Age', 'Message'], ...ev.slice(-10).map((e) => ['  ' + e.type, e.reason, age(c, e.tick), e.message])]) : '  <none>'}`;
  }
  if (t.kind === 'deployments') {
    const d = c.deployment(t.name);
    observe?.({ verb: 'describe', kind: 'deployments', name: d.name });
    const s = c.deploymentStatus(d.name);
    const sets = [...c.replicasets.values()].filter((r) => r.owner === d.name);
    const ev = c.events.filter((e) => e.object === `deployment/${d.name}` || sets.some((r) => e.object === `replicaset/${r.name}`));
    return `Name:                   ${d.name}
Replicas:               ${s.desired} desired | ${s.upToDate} updated | ${s.current} total | ${s.available} available
StrategyType:           RollingUpdate (maxSurge 1, maxUnavailable 0)
Pod Template:
  Image:   ${d.template.image}
Conditions:
  Type             Status  Reason
  Available        ${s.available >= s.desired ? 'True ' : 'False'}   ${s.available >= s.desired ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable'}${s.replicaFailure ? '\n  ReplicaFailure   True    FailedCreate' : ''}
Events:
${ev.length ? table([['  Type', 'Reason', 'Age', 'Message'], ...ev.slice(-10).map((e) => ['  ' + e.type, e.reason, age(c, e.tick), e.message])]) : '  <none>'}`;
  }
  if (t.kind === 'nodes') {
    const n = c.nodes.find((x) => x.name === t.name);
    if (!n) throw new Error(`Error from server (NotFound): nodes "${t.name}" not found`);
    const u = c.used(n.name);
    const pods = [...c.pods.values()].filter((p) => p.node === n.name);
    return `Name:      ${n.name}
Allocatable:
  cpu:     ${n.cpu}m
  memory:  ${fmtMem(n.mem)}
Allocated resources:
  cpu      ${u.cpu}m (${Math.round((u.cpu / n.cpu) * 100)}%)
  memory   ${fmtMem(u.mem)} (${Math.round((u.mem / n.mem) * 100)}%)
Non-terminated Pods: (${pods.length} in total)
${pods.map((p) => `  ${p.name}  cpu ${p.template.requests.cpu}m`).join('\n')}`;
  }
  if (t.kind === 'resourcequotas') {
    if (!c.quota || c.quota.name !== t.name) throw new Error(`Error from server (NotFound): resourcequotas "${t.name ?? ''}" not found`);
    const used = [...c.pods.values()].filter((p) => p.status !== 'Terminating').length;
    return `Name:       ${c.quota.name}\nResource    Used  Hard\n--------    ----  ----\npods        ${used}     ${c.quota.pods}`;
  }
  throw new Error(`error: describe supports pod, deploy, node and quota here`);
}
