// kubectl for the storage sandbox. Every message and column header here was
// copied from kubectl 1.37.2 against a 1.36.1 kind cluster while these lessons
// were written; tests/kube-storage.test.ts pins each one and says which
// command produced it. Anything the sandbox does not model is refused by name.

import { Storage, SECONDS_PER_TICK, NODE, IMAGES, type Claim, type Pod } from './storage.ts';
import { parseYaml, YamlError, type YamlValue } from './yaml.ts';
import { table, human, eventsBlock, tokenize, parseFlags, CmdError, type Out } from '../kube-ops/print.ts';

export type Files = Map<string, string>;
export type Seen = (what: string) => void;

const o = (text: string): Out[] => text ? text.split('\n').map((t) => ({ text: t, kind: 'out' as const })) : [];
const e = (text: string): Out[] => text.split('\n').map((t) => ({ text: t, kind: 'err' as const }));
const note = (text: string): Out => ({ text, kind: 'dim' });

const KIND: Record<string, string> = {
  pvc: 'pvc', persistentvolumeclaim: 'pvc', persistentvolumeclaims: 'pvc',
  pv: 'pv', persistentvolume: 'pv', persistentvolumes: 'pv',
  sc: 'sc', storageclass: 'sc', storageclasses: 'sc',
  po: 'pod', pod: 'pod', pods: 'pod',
  sts: 'sts', statefulset: 'sts', statefulsets: 'sts',
  svc: 'svc', service: 'svc', services: 'svc',
  ev: 'ev', event: 'ev', events: 'ev',
};
const FULL: Record<string, string> = { pvc: 'persistentvolumeclaim', pv: 'persistentvolume', sc: 'storageclass.storage.k8s.io', pod: 'pod', sts: 'statefulset.apps', svc: 'service' };
const NOT_MODELLED = new Set(['deploy', 'deployment', 'deployments', 'rs', 'replicaset', 'replicasets', 'cm', 'configmap', 'configmaps', 'secret', 'secrets', 'no', 'node', 'nodes', 'ns', 'namespace', 'namespaces', 'ing', 'ingress', 'job', 'jobs', 'ds', 'daemonset', 'daemonsets', 'volumesnapshot', 'volumesnapshots', 'vac', 'volumeattributesclass', 'csidriver', 'csidrivers', 'csinode', 'all']);

function kindOf(word: string | undefined): string {
  if (!word) throw new CmdError('error: you must specify the type of resource to get. Try: kubectl get pvc');
  const k = KIND[word.toLowerCase()];
  if (k) return k;
  if (NOT_MODELLED.has(word.toLowerCase())) throw new CmdError(`sandbox: this storage sandbox does not model ${word}. It knows pvc, pv, sc, pods, sts, svc and events.`);
  throw new CmdError(`error: the server doesn't have a resource type "${word}"`);
}

/** "sts/web", "sts web" and "statefulset.apps/web" all name the same thing. */
function target(pos: string[]): { kind: string; names: string[] } {
  if (!pos.length) throw new CmdError('error: you must specify the type of resource');
  if (pos[0].includes('/')) {
    const [k, n] = pos[0].split('/');
    return { kind: kindOf(k.replace(/\.(apps|storage\.k8s\.io)$/, '')), names: [n, ...pos.slice(1).map((p) => p.split('/').pop()!)] };
  }
  return { kind: kindOf(pos[0]), names: pos.slice(1) };
}

const notFound = (kind: string, name: string) => new CmdError(`Error from server (NotFound): ${FULL[kind].replace(/\..*$/, '').replace('persistentvolumeclaim', 'persistentvolumeclaims').replace('persistentvolume', 'persistentvolumes').replace(/^(pod|service)$/, '$1s').replace(/^storageclass$/, 'storageclasses.storage.k8s.io').replace(/^statefulset$/, 'statefulsets.apps')} "${name}" not found`);

export function kubectl(s: Storage, files: Files, line: string, seen: Seen = () => {}): Out[] {
  try {
    const words = tokenize(line.trim());
    if (!words.length) return [];
    if (words[0] === 'help') return o(HELP);
    if (words[0] === 'ls') return o([...files.keys()].sort().join('  '));
    if (words[0] === 'cat') {
      if (!words[1]) throw new CmdError('cat: missing file name');
      const f = files.get(words[1]);
      if (f === undefined) throw new CmdError(`cat: ${words[1]}: No such file or directory`);
      return o(f.replace(/\n$/, ''));
    }
    if (words[0] === 'docker') return docker(s, words.slice(1), seen);
    if (words[0] !== 'kubectl') throw new CmdError(`sandbox: ${words[0]}: command not found here. Type help for what this sandbox runs.`);
    const verb = words[1];
    const rest = words.slice(2);
    switch (verb) {
      case 'get': return get(s, rest, seen);
      case 'describe': return describe(s, rest, seen);
      case 'apply': return apply(s, files, rest);
      case 'delete': return del(s, files, rest, seen);
      case 'scale': return scale(s, rest);
      case 'patch': return patch(s, rest);
      case 'set': return setImage(s, rest);
      case 'exec': return exec(s, rest, seen);
      case 'rollout': return rollout(s, rest);
      case 'create': throw new CmdError('sandbox: kubectl has no create command for claims or StatefulSets. Write them in a file and use kubectl apply -f <file>.');
      case 'edit': throw new CmdError('sandbox: kubectl edit opens an editor this sandbox does not have. Change the file in the editor panel, then kubectl apply -f <file>.');
      case undefined: return o(HELP);
      default: throw new CmdError(`sandbox: kubectl ${verb} is not part of this storage sandbox. Type help for the list.`);
    }
  } catch (x) {
    if (x instanceof CmdError || x instanceof YamlError) return e(x.message);
    // Anything else is a bug in the sandbox, and must say so rather than look like Kubernetes.
    return e(`a bug in the sandbox, not in your command: ${(x as Error).message}`);
  }
}

export const HELP = `This sandbox is a one-node kind cluster with the local-path provisioner.
  kubectl get pvc|pv|sc|pods|sts|svc|events [name]     (comma lists work: get pods,pvc)
  kubectl describe pvc|pv|sc|pod|sts <name>
  kubectl apply -f <file>          kubectl delete pvc|pv|pod|sts <name>   kubectl delete -f <file>
  kubectl scale sts <name> --replicas=N
  kubectl set image sts/<name> app=<image>       kubectl rollout status sts/<name>
  kubectl patch pv|pvc|sts <name> -p '<json>'
  kubectl exec <pod> -- ls|cat <path>     kubectl exec <pod> -- sh -c "echo <text> > <path>"
  docker exec ${NODE} ls|cat <path>        (the node's own disk)
  ls, cat <file>, and the editor panel for the files.
Images: ${[...IMAGES].join('  ')}`;

const age = (s: Storage, since: number) => human(s.seconds - since * SECONDS_PER_TICK);
const modes = (m: string[]) => m.map((x) => ({ ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' } as Record<string, string>)[x] ?? x).join(',');

const GET_FLAGS = new Set(['-o', '--output', '-w', '--watch', '-n', '--namespace', '-A', '--all-namespaces', '-l', '--selector', '--show-labels']);
function get(s: Storage, args: string[], seen: Seen): Out[] {
  const { pos, flags } = parseFlags(args, new Set(['-o', '--output', '-n', '--namespace', '-l', '--selector']), GET_FLAGS);
  for (const f of ['-w', '--watch']) if (flags.has(f)) throw new CmdError('sandbox: --watch keeps printing as things change; here, run the command again instead (time keeps running).');
  for (const f of ['-l', '--selector', '--show-labels', '-o', '--output']) if (flags.has(f) && !(f.startsWith('-o') || f === '--output') ) throw new CmdError(`sandbox: ${f} is not modelled here.`);
  const ofmt = flags.get('-o') ?? flags.get('--output');
  if (ofmt && ofmt !== 'wide') throw new CmdError(`sandbox: -o ${ofmt} is not modelled here; only -o wide.`);
  const ns = flags.get('-n') ?? flags.get('--namespace');
  if (ns && ns !== 'default') return o(`No resources found in ${ns} namespace.`);
  if (flags.has('-A') || flags.has('--all-namespaces')) throw new CmdError('sandbox: this sandbox has one namespace, default. Leave out -A.');
  if (!pos.length) throw new CmdError('error: you must specify the type of resource to get. Try: kubectl get pvc');
  let kinds: string[], names: string[];
  if (pos[0].includes(',')) { kinds = pos[0].split(',').map(kindOf); names = pos.slice(1); }
  else { const t = target(pos); kinds = [t.kind]; names = t.names; }
  if (kinds.length > 1 && names.length) throw new CmdError('error: you may only specify a single resource type when naming resources');
  const blocks: string[] = [];
  for (const k of kinds) {
    seen(`get:${k}`);
    const b = listing(s, k, names, kinds.length > 1, ofmt === 'wide');
    if (b) blocks.push(b);
  }
  if (!blocks.length) return o(kinds.some((k) => k === 'pv' || k === 'sc') && kinds.length === 1 ? 'No resources found' : 'No resources found in default namespace.');
  return o(blocks.join('\n\n'));
}

function listing(s: Storage, kind: string, names: string[], prefix: boolean, wide: boolean): string {
  const pick = <T extends { name: string }>(all: Iterable<T>): T[] => {
    const list = [...all].sort((a, b) => a.name.localeCompare(b.name));
    if (!names.length) return list;
    return names.map((n) => { const f = list.find((x) => x.name === n); if (!f) throw notFound(kind, n); return f; });
  };
  const pre = (n: string) => (prefix ? `${FULL[kind].replace('storageclass.storage.k8s.io', 'storageclass.storage.k8s.io')}/${n}` : n);
  switch (kind) {
    case 'pvc': {
      const rows = pick(s.claims.values()).map((c) => [pre(c.name), c.deleting ? 'Terminating' : c.phase, c.volume ?? '', c.phase === 'Bound' ? c.size : '', c.phase === 'Bound' ? modes(c.modes) : '', c.className ?? '', '<unset>', age(s, c.created), ...(wide ? ['Filesystem'] : [])]);
      return rows.length ? table([['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'AGE', ...(wide ? ['VOLUMEMODE'] : [])], ...rows]) : '';
    }
    case 'pv': {
      const rows = pick(s.volumes.values()).map((v) => [pre(v.name), v.size, modes(v.modes), v.reclaim, v.status, `default/${v.claim}`, v.className, '<unset>', '', age(s, v.created), ...(wide ? ['Filesystem'] : [])]);
      return rows.length ? table([['NAME', 'CAPACITY', 'ACCESS MODES', 'RECLAIM POLICY', 'STATUS', 'CLAIM', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'REASON', 'AGE', ...(wide ? ['VOLUMEMODE'] : [])], ...rows]) : '';
    }
    case 'sc': {
      const rows = pick(s.classes.values()).map((c) => [pre(c.name) + (c.isDefault ? ' (default)' : ''), c.provisioner, c.reclaimPolicy, c.bindingMode, 'false', age(s, c.created)]);
      return rows.length ? table([['NAME', 'PROVISIONER', 'RECLAIMPOLICY', 'VOLUMEBINDINGMODE', 'ALLOWVOLUMEEXPANSION', 'AGE'], ...rows]) : '';
    }
    case 'pod': {
      const rows = pick(s.pods.values()).map((p) => [pre(p.name), `${p.ready ? 1 : 0}/1`, p.status, '0', age(s, p.created), ...(wide ? [p.node ? `10.244.0.${10 + (p.created % 200)}` : '<none>', p.node ?? '<none>', '<none>', '<none>'] : [])]);
      return rows.length ? table([['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : [])], ...rows]) : '';
    }
    case 'sts': {
      const rows = pick(s.sets.values()).map((t) => [pre(t.name), `${s.readyCount(t.name)}/${t.replicas}`, age(s, t.created), ...(wide ? ['app', t.image] : [])]);
      return rows.length ? table([['NAME', 'READY', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES'] : [])], ...rows]) : '';
    }
    case 'svc': {
      const rows = pick(s.services.values()).map((v) => [pre(v.name), 'ClusterIP', v.headless ? 'None' : '10.96.0.20', '<none>', '80/TCP', age(s, v.created)]);
      return rows.length ? table([['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'], ...rows]) : '';
    }
    case 'ev': {
      const all: [string, string, { type: string; reason: string; message: string; last: number }][] = [];
      for (const c of s.claims.values()) for (const ev of c.events) all.push([`persistentvolumeclaim/${c.name}`, '', ev]);
      for (const p of s.pods.values()) for (const ev of p.events) all.push([`pod/${p.name}`, '', ev]);
      for (const t of s.sets.values()) for (const ev of t.events) all.push([`statefulset/${t.name}`, '', ev]);
      if (!all.length) return '';
      all.sort((a, b) => a[2].last - b[2].last);
      return table([['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], ...all.map(([obj, , ev]) => [age(s, ev.last), ev.type, ev.reason, obj, ev.message])]);
    }
  }
  return '';
}

function describe(s: Storage, args: string[], seen: Seen): Out[] {
  const { pos } = parseFlags(args, new Set(['-n', '--namespace']), new Set(['-n', '--namespace']));
  const t = target(pos);
  if (!t.names.length) throw new CmdError(`sandbox: name the ${t.kind} to describe, for example kubectl describe ${t.kind} <name>`);
  return o(t.names.map((n) => { seen(`describe:${t.kind}:${n}`); return describeOne(s, t.kind, n); }).join('\n\n\n'));
}

const ev = (s: Storage, list: Claim['events']) => eventsBlock(list, s.seconds, SECONDS_PER_TICK);
const pad = (label: string, w: number) => (label + ':').padEnd(w);

function describeOne(s: Storage, kind: string, name: string): string {
  if (kind === 'pvc') {
    const c = s.claims.get(name);
    if (!c) throw notFound('pvc', name);
    const users = [...s.pods.values()].filter((p) => p.claims.some((x) => x.claim === c.name)).map((p) => p.name);
    const sc = c.className ? s.classes.get(c.className) : undefined;
    const ann = c.phase === 'Bound' ? ['pv.kubernetes.io/bind-completed: yes', 'pv.kubernetes.io/bound-by-controller: yes', `volume.beta.kubernetes.io/storage-provisioner: ${sc?.provisioner}`, `volume.kubernetes.io/selected-node: ${NODE}`, `volume.kubernetes.io/storage-provisioner: ${sc?.provisioner}`]
      : c.selectedNode ? [`volume.kubernetes.io/selected-node: ${NODE}`] : ['<none>'];
    const w = 15;
    return [
      `${pad('Name', w)}${c.name}`, `${pad('Namespace', w)}default`, `${pad('StorageClass', w)}${c.className ?? ''}`,
      `${pad('Status', w)}${c.deleting ? 'Terminating (lasts 0s)' : c.phase}`, `${pad('Volume', w)}${c.volume ?? ''}`, `${pad('Labels', w)}${c.ownerSts ? `app=${c.ownerSts}` : '<none>'}`,
      `${pad('Annotations', w)}${ann[0]}`, ...ann.slice(1).map((a) => ' '.repeat(w) + a),
      `${pad('Finalizers', w)}[kubernetes.io/pvc-protection]`, `${pad('Capacity', w)}${c.phase === 'Bound' ? c.size : ''}`, `${pad('Access Modes', w)}${c.phase === 'Bound' ? modes(c.modes) : ''}`,
      `${pad('VolumeMode', w)}Filesystem`, `${pad('Used By', w)}${users.length ? users.join(', ') : '<none>'}`, ev(s, c.events),
    ].join('\n');
  }
  if (kind === 'pv') {
    const v = s.volumes.get(name);
    if (!v) throw notFound('pv', name);
    const w = 19;
    return [
      `${pad('Name', w)}${v.name}`, `${pad('Labels', w)}<none>`, `${pad('Annotations', w)}local.path.provisioner/selected-node: ${NODE}`, `${' '.repeat(w)}pv.kubernetes.io/provisioned-by: rancher.io/local-path`,
      `${pad('Finalizers', w)}[kubernetes.io/pv-protection]`, `${pad('StorageClass', w)}${v.className}`, `${pad('Status', w)}${v.status}`, `${pad('Claim', w)}default/${v.claim}`,
      `${pad('Reclaim Policy', w)}${v.reclaim}`, `${pad('Access Modes', w)}${modes(v.modes)}`, `${pad('VolumeMode', w)}Filesystem`, `${pad('Capacity', w)}${v.size}`,
      `${pad('Node Affinity', w)}`, `  ${pad('Required Terms', w - 2)}`, `    ${pad('Term 0', w - 4)}kubernetes.io/hostname in [${NODE}]`, `${pad('Message', w)}`, 'Source:',
      `    ${pad('Type', w - 4)}HostPath (bare host directory volume)`, `    ${pad('Path', w - 4)}${s.hostPath(v)}`, `    ${pad('HostPathType', w - 4)}DirectoryOrCreate`, `${pad('Events', w)}<none>`,
    ].join('\n');
  }
  if (kind === 'sc') {
    const c = s.classes.get(name);
    if (!c) throw notFound('sc', name);
    const w = 23;
    return [`${pad('Name', 17)}${c.name}`, `${pad('IsDefaultClass', 17)}${c.isDefault ? 'Yes' : 'No'}`, `${pad('Annotations', 17)}${c.isDefault ? 'storageclass.kubernetes.io/is-default-class=true' : '<none>'}`,
      `${pad('Provisioner', w)}${c.provisioner}`, `${pad('Parameters', w)}<none>`, `${pad('AllowVolumeExpansion', w)}<unset>`, `${pad('MountOptions', w)}<none>`,
      `${pad('ReclaimPolicy', w)}${c.reclaimPolicy}`, `${pad('VolumeBindingMode', w)}${c.bindingMode}`, `${pad('Events', w)}<none>`].join('\n');
  }
  if (kind === 'pod') {
    const p = s.pods.get(name);
    if (!p) throw notFound('pod', name);
    const w = 18;
    const vols = p.claims.flatMap((c) => [`  ${c.volume}:`, '    Type:       PersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)', `    ClaimName:  ${c.claim}`, '    ReadOnly:   false']);
    return [
      `${pad('Name', w)}${p.name}`, `${pad('Namespace', w)}default`, `${pad('Node', w)}${p.node ? `${p.node}/172.18.0.2` : '<none>'}`, `${pad('Status', w)}${p.status === 'ContainerCreating' || p.status === 'ErrImagePull' || p.status === 'ImagePullBackOff' ? 'Pending' : p.status}`,
      ...(p.owner ? [`${pad('Controlled By', w)}StatefulSet/${p.owner}`] : []),
      'Containers:', '  app:', `    Image:          ${p.image}`, `    State:          ${p.status === 'Running' ? 'Running' : p.node ? `Waiting\n      Reason:       ${p.status}` : 'Waiting'}`, `    Ready:          ${p.ready ? 'True' : 'False'}`,
      '    Mounts:', ...p.claims.map((c) => `      ${c.mountPath} from ${c.volume} (rw)`),
      'Conditions:', '  Type           Status', `  PodScheduled   ${p.node ? 'True' : 'False'} `, ...(p.node ? [`  Ready          ${p.ready ? 'True' : 'False'} `] : []),
      'Volumes:', ...vols,
      `${pad('QoS Class', 29)}BestEffort`, `${pad('Node-Selectors', 29)}<none>`,
      `${pad('Tolerations', 29)}node.kubernetes.io/not-ready:NoExecute op=Exists for 300s`, `${' '.repeat(29)}node.kubernetes.io/unreachable:NoExecute op=Exists for 300s`,
      ev(s, p.events),
    ].join('\n');
  }
  if (kind === 'sts') {
    const t = s.sets.get(name);
    if (!t) throw notFound('sts', name);
    const pods = [...s.pods.values()].filter((p) => p.owner === t.name);
    const w = 20;
    return [
      `${pad('Name', w)}${t.name}`, `${pad('Namespace', w)}default`, `${pad('Selector', w)}app=${t.name}`, `${pad('Replicas', w)}${t.replicas} desired | ${pods.length} total`,
      `${pad('Update Strategy', w)}RollingUpdate`, `  ${pad('Partition', w - 2)}0`,
      `${pad('Pods Status', w)}${pods.filter((p) => p.status === 'Running').length} Running / ${pods.filter((p) => p.status !== 'Running' && p.status !== 'Terminating').length} Waiting / 0 Succeeded / 0 Failed`,
      'Pod Template:', `  Labels:  app=${t.name}`, '  Containers:', '   app:', `    Image:        ${t.image}`, '    Mounts:', `      ${t.mountPath} from ${t.templates[0]?.name ?? 'data'} (rw)`,
      'Volume Claims:', ...t.templates.flatMap((v) => [`  Name:          ${v.name}`, `  StorageClass:  ${v.className ?? ''}`, `  Capacity:      ${v.size}`, `  Access Modes:  [${v.modes.join(' ')}]`]),
      ev(s, t.events),
    ].join('\n');
  }
  throw new CmdError(`sandbox: describe ${kind} is not modelled here.`);
}

// ---- apply ------------------------------------------------------------------

type Obj = { [k: string]: YamlValue };
const isObj = (v: YamlValue | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Refuse any field the sandbox does not model, by its path, so nothing is silently ignored. */
function only(o: Obj, allowed: string[], path: string, kind: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new CmdError(`sandbox: ${kind} field "${path}${k}" is real Kubernetes, but this sandbox does not model it. Remove it to apply here.`);
}
// What a real API server says about a field that does not exist at all. Copied
// from applying a claim with "storageClass:" (missing "Name") on 1.36.1.
const REAL_FIELDS: Record<string, string[]> = {
  'PersistentVolumeClaim.spec': ['accessModes', 'selector', 'resources', 'volumeName', 'storageClassName', 'volumeMode', 'dataSource', 'dataSourceRef', 'volumeAttributesClassName'],
};
function strict(kind: string, file: string, path: string, o: Obj) {
  const real = REAL_FIELDS[`${kind}.${path}`];
  if (!real) return;
  for (const k of Object.keys(o)) if (!real.includes(k))
    throw new CmdError(`Error from server (BadRequest): error when creating "${file}": ${kind} in version "v1" cannot be handled as a ${kind}: strict decoding error: unknown field "${path}.${k}"`);
}

const str = (v: YamlValue | undefined, what: string): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  throw new CmdError(`sandbox: ${what} must be text`);
};
const modeList = (v: YamlValue | undefined, what: string): string[] => {
  if (!Array.isArray(v) || !v.length) throw new CmdError(`The PersistentVolumeClaim is invalid: ${what}: Required value: at least 1 access mode is required`);
  const ok = ['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'];
  return v.map((m) => { if (typeof m !== 'string' || !ok.includes(m)) throw new CmdError(`The PersistentVolumeClaim is invalid: ${what}: Unsupported value: "${String(m)}": supported values: "ReadOnlyMany", "ReadWriteMany", "ReadWriteOnce", "ReadWriteOncePod"`); return m; });
};

type ClaimSpec = { className: string | null; modes: string[]; size: string };
function claimSpec(spec: Obj, name: string, file: string): ClaimSpec {
  strict('PersistentVolumeClaim', file, 'spec', spec);
  only(spec, ['accessModes', 'resources', 'storageClassName'], 'spec.', 'PersistentVolumeClaim');
  const res = spec.resources;
  const size = isObj(res) && isObj(res.requests) ? res.requests.storage : undefined;
  if (isObj(res)) only(res, ['requests'], 'spec.resources.', 'PersistentVolumeClaim');
  if (size === undefined || size === null) throw new CmdError(`The PersistentVolumeClaim "${name}" is invalid: spec.resources[storage]: Required value`);
  const sz = str(size, 'spec.resources.requests.storage');
  if (!/^\d+(Mi|Gi|Ti)$/.test(sz)) throw new CmdError(`sandbox: storage size "${sz}" - write it like 1Gi or 500Mi`);
  const cls = spec.storageClassName;
  return { className: cls === undefined || cls === null ? null : str(cls, 'spec.storageClassName'), modes: modeList(spec.accessModes, 'spec.accessModes'), size: sz };
}

type ContainerSpec = { image: string; mounts: { name: string; mountPath: string }[] };
function container(spec: Obj, path: string, kind: string): ContainerSpec {
  only(spec, ['containers', 'volumes'], path, kind);
  const cs = spec.containers;
  if (!Array.isArray(cs) || cs.length !== 1 || !isObj(cs[0])) throw new CmdError(`sandbox: ${kind} ${path}containers must list exactly one container here (the sandbox models one per pod).`);
  const c = cs[0];
  only(c, ['name', 'image', 'volumeMounts'], `${path}containers[0].`, kind);
  if (c.name !== 'app') throw new CmdError(`sandbox: name the container app (kubectl set image here addresses it as app=<image>).`);
  const mounts = Array.isArray(c.volumeMounts) ? c.volumeMounts.map((m, i) => {
    if (!isObj(m)) throw new CmdError(`sandbox: ${path}containers[0].volumeMounts[${i}] must be a mapping`);
    only(m, ['name', 'mountPath'], `${path}containers[0].volumeMounts[${i}].`, kind);
    return { name: str(m.name, 'volumeMounts name'), mountPath: str(m.mountPath, 'mountPath') };
  }) : [];
  return { image: str(c.image, 'image'), mounts };
}

function podClaims(spec: Obj, mounts: ContainerSpec['mounts'], kind: string): Pod['claims'] {
  const vols = Array.isArray(spec.volumes) ? spec.volumes : [];
  return mounts.map((m) => {
    const v = vols.find((x) => isObj(x) && x.name === m.name);
    if (!isObj(v)) throw new CmdError(`The ${kind} is invalid: spec.containers[0].volumeMounts[0].name: Not found: "${m.name}"`);
    only(v, ['name', 'persistentVolumeClaim'], 'spec.volumes[].', kind);
    const pvc = v.persistentVolumeClaim;
    if (!isObj(pvc)) throw new CmdError(`sandbox: volume "${m.name}" must be a persistentVolumeClaim here (emptyDir, hostPath and the rest are not modelled).`);
    only(pvc, ['claimName'], 'spec.volumes[].persistentVolumeClaim.', kind);
    return { volume: m.name, claim: str(pvc.claimName, 'claimName'), mountPath: m.mountPath };
  });
}

function apply(s: Storage, files: Files, args: string[]): Out[] {
  const { flags } = parseFlags(args, new Set(['-f', '--filename']), new Set(['-f', '--filename']));
  const file = flags.get('-f') ?? flags.get('--filename');
  if (!file) throw new CmdError('error: must specify one of -f and -k');
  const src = files.get(file);
  if (src === undefined) throw new CmdError(`error: the path "${file}" does not exist`);
  const docs = parseYaml(src).filter((d) => d !== null);
  // Validate everything first: a real apply goes object by object, but a
  // sandbox refusal half-way through would leave a state no cluster would.
  const plan = docs.map((d, i) => toObject(d, file, i));
  const lines: Out[] = [];
  for (const p of plan) {
    const r = p(s);
    lines.push(...r);
  }
  return lines;
}

function toObject(d: YamlValue, file: string, i: number): (s: Storage) => Out[] {
  if (!isObj(d)) throw new CmdError(`error: error validating "${file}": document ${i + 1} is not an object`);
  const kind = d.kind, meta = d.metadata;
  if (typeof kind !== 'string') throw new CmdError(`error: error validating data: kind not set`);
  if (!isObj(meta) || typeof meta.name !== 'string') throw new CmdError(`error: error when retrieving current configuration: resource name may not be empty`);
  const name = meta.name;
  only(meta, kind === 'StatefulSet' ? ['name', 'labels'] : kind === 'StorageClass' ? ['name', 'annotations'] : ['name'], 'metadata.', kind);
  if (kind !== 'StorageClass') only(d, ['apiVersion', 'kind', 'metadata', 'spec'], '', kind);
  const spec = isObj(d.spec) ? d.spec : {};
  switch (kind) {
    case 'PersistentVolumeClaim': {
      if (d.apiVersion !== 'v1') throw new CmdError(`error: resource mapping not found for name: "${name}" namespace: "" from "${file}": no matches for kind "PersistentVolumeClaim" in version "${String(d.apiVersion)}"`);
      const want = claimSpec(spec, name, file);
      return (s) => {
        const have = s.claims.get(name);
        if (!have) { s.addClaim({ name, ...want }); return o(`persistentvolumeclaim/${name} created`); }
        const same = (have.className === want.className || (want.className === null)) && have.size === want.size && have.modes.join() === want.modes.join();
        if (have.deleting) return [{ text: `Warning: Detected changes to resource ${name} which is currently being deleted.`, kind: 'err' }, ...o(`persistentvolumeclaim/${name} unchanged`)];
        if (same) return o(`persistentvolumeclaim/${name} unchanged`);
        return e(immutable(name));
      };
    }
    case 'Pod': {
      if (d.apiVersion !== 'v1') throw new CmdError(`error: no matches for kind "Pod" in version "${String(d.apiVersion)}"`);
      const c = container(spec, 'spec.', 'Pod');
      const claims = podClaims(spec, c.mounts, `Pod "${name}"`);
      return (s) => {
        const have = s.pods.get(name);
        if (!have) { s.addPod({ name, image: c.image, claims }); return o(`pod/${name} created`); }
        const sameShape = JSON.stringify(have.claims) === JSON.stringify(claims);
        if (!sameShape) return e(`The Pod "${name}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`,\`spec.initContainers[*].image\`,\`spec.activeDeadlineSeconds\`,\`spec.tolerations\` (only additions to existing tolerations),\`spec.terminationGracePeriodSeconds\` (allow it to be set to 1 if it was previously negative)`);
        // Real apply printed "configured" for an unchanged Pod on 1.36.1, every time.
        if (have.image !== c.image) { have.image = c.image; if (have.node) { have.status = 'ContainerCreating'; have.ready = false; have.startAt = s.tick + 1; } }
        return o(`pod/${name} configured`);
      };
    }
    case 'Service': {
      only(spec, ['clusterIP', 'selector', 'ports'], 'spec.', 'Service');
      return (s) => {
        if (s.services.has(name)) return o(`service/${name} unchanged`);
        s.services.set(name, { name, headless: spec.clusterIP === 'None', created: s.tick });
        return o(`service/${name} created`);
      };
    }
    case 'StorageClass': {
      only(d, ['apiVersion', 'kind', 'metadata', 'provisioner', 'reclaimPolicy', 'volumeBindingMode'], '', 'StorageClass');
      const prov = str(d.provisioner, 'provisioner');
      if (prov !== 'rancher.io/local-path') throw new CmdError(`sandbox: the only provisioner running in this cluster is rancher.io/local-path. A class naming "${prov}" would be accepted by a real cluster and then provision nothing.`);
      const rp = d.reclaimPolicy === undefined ? 'Delete' : str(d.reclaimPolicy, 'reclaimPolicy');
      const bm = d.volumeBindingMode === undefined ? 'Immediate' : str(d.volumeBindingMode, 'volumeBindingMode');
      if (rp !== 'Delete' && rp !== 'Retain') throw new CmdError(`The StorageClass "${name}" is invalid: reclaimPolicy: Unsupported value: "${rp}": supported values: "Delete", "Retain"`);
      if (bm !== 'Immediate' && bm !== 'WaitForFirstConsumer') throw new CmdError(`The StorageClass "${name}" is invalid: volumeBindingMode: Unsupported value: "${bm}": supported values: "Immediate", "WaitForFirstConsumer"`);
      const isDefault = isObj(meta.annotations) && meta.annotations['storageclass.kubernetes.io/is-default-class'] === 'true';
      return (s) => {
        if (s.classes.has(name)) return o(`storageclass.storage.k8s.io/${name} unchanged`);
        s.classes.set(name, { name, provisioner: prov, reclaimPolicy: rp as 'Delete', bindingMode: bm as 'Immediate', isDefault, created: s.tick, byLearner: true });
        return o(`storageclass.storage.k8s.io/${name} created`);
      };
    }
    case 'StatefulSet': {
      if (d.apiVersion !== 'apps/v1') throw new CmdError(`error: no matches for kind "StatefulSet" in version "${String(d.apiVersion)}"`);
      only(spec, ['serviceName', 'replicas', 'selector', 'template', 'volumeClaimTemplates', 'persistentVolumeClaimRetentionPolicy'], 'spec.', 'StatefulSet');
      const tpl = isObj(spec.template) ? spec.template : {};
      only(tpl, ['metadata', 'spec'], 'spec.template.', 'StatefulSet');
      const c = container(isObj(tpl.spec) ? tpl.spec : {}, 'spec.template.spec.', 'StatefulSet');
      const vcts = (Array.isArray(spec.volumeClaimTemplates) ? spec.volumeClaimTemplates : []).map((v, k) => {
        if (!isObj(v) || !isObj(v.metadata) || !isObj(v.spec)) throw new CmdError(`sandbox: volumeClaimTemplates[${k}] needs metadata.name and spec`);
        const cs = claimSpec(v.spec, `${str(v.metadata.name, 'name')}`, file);
        return { name: str(v.metadata.name, 'name'), ...cs };
      });
      if (c.mounts.length !== 1 || !vcts.find((v) => v.name === c.mounts[0].name)) throw new CmdError('sandbox: mount exactly one volume, from volumeClaimTemplates, in the container here.');
      const replicas = spec.replicas === undefined ? 1 : Number(spec.replicas);
      if (!Number.isInteger(replicas) || replicas < 0) throw new CmdError('The StatefulSet is invalid: spec.replicas: Invalid value: must be greater than or equal to 0');
      const ret = isObj(spec.persistentVolumeClaimRetentionPolicy) ? spec.persistentVolumeClaimRetentionPolicy : {};
      return (s) => {
        const have = s.sets.get(name);
        if (!have) {
          s.sets.set(name, { name, replicas, image: c.image, serviceName: str(spec.serviceName ?? name, 'serviceName'), mountPath: c.mounts[0].mountPath, templates: vcts,
            whenDeleted: ret.whenDeleted === 'Delete' ? 'Delete' : 'Retain', whenScaled: ret.whenScaled === 'Delete' ? 'Delete' : 'Retain', revision: 1, created: s.tick, events: [], labels: { app: name } });
          return o(`statefulset.apps/${name} created`);
        }
        let changed = false;
        if (have.replicas !== replicas) { have.replicas = replicas; changed = true; }
        if (have.image !== c.image) { have.image = c.image; have.revision++; changed = true; }
        return o(`statefulset.apps/${name} ${changed ? 'configured' : 'unchanged'}`);
      };
    }
    default:
      throw new CmdError(`sandbox: this storage sandbox applies PersistentVolumeClaim, Pod, StatefulSet, Service and StorageClass, not ${kind}.`);
  }
}

const immutable = (name: string) => `The PersistentVolumeClaim "${name}" is invalid: spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims`;

// ---- delete, scale, patch, set image, rollout --------------------------------

function del(s: Storage, files: Files, args: string[], seen: Seen): Out[] {
  const { pos, flags } = parseFlags(args, new Set(['-f', '--filename', '--wait', '--grace-period']), new Set(['-f', '--filename', '--wait', '--now', '--force', '--grace-period']));
  if (flags.has('--force') || flags.has('--grace-period')) throw new CmdError('sandbox: --force and --grace-period skip the graceful shutdown; this sandbox does not model that.');
  const file = flags.get('-f') ?? flags.get('--filename');
  let items: { kind: string; name: string }[];
  if (file) {
    const src = files.get(file);
    if (src === undefined) throw new CmdError(`error: the path "${file}" does not exist`);
    items = parseYaml(src).filter(isObj).map((d) => ({ kind: ({ PersistentVolumeClaim: 'pvc', Pod: 'pod', StatefulSet: 'sts', Service: 'svc', StorageClass: 'sc' } as Record<string, string>)[String(d.kind)] ?? '', name: String(isObj(d.metadata) ? d.metadata.name : '') }));
  } else {
    const t = target(pos);
    if (!t.names.length) throw new CmdError('error: resource(s) were provided, but no name was specified');
    items = t.names.map((name) => ({ kind: t.kind, name }));
  }
  const lines: Out[] = [];
  let waits = false;
  for (const { kind, name } of items) {
    const where = kind === 'pv' || kind === 'sc' ? '' : ' from default namespace';
    const label = `${FULL[kind]?.replace('.storage.k8s.io', '.storage.k8s.io') ?? kind} "${name}" deleted${where}`;
    if (kind === 'pvc') {
      const c = s.claims.get(name);
      if (!c) { lines.push(...e(notFound('pvc', name).message)); continue; }
      seen(`deleted:pvc:${name}`);
      s.deleteClaim(name);
      if (s.inUse(name)) waits = true;
    } else if (kind === 'pod') {
      if (!s.pods.has(name)) { lines.push(...e(notFound('pod', name).message)); continue; }
      seen(`deleted:pod:${name}`);
      s.deletePod(name);
    } else if (kind === 'sts') {
      if (!s.sets.has(name)) { lines.push(...e(notFound('sts', name).message)); continue; }
      s.deleteSet(name);
    } else if (kind === 'pv') {
      const v = s.volumes.get(name);
      if (!v) { lines.push(...e(notFound('pv', name).message)); continue; }
      if (v.status === 'Bound') throw new CmdError('sandbox: a Bound volume is held by the pv-protection finalizer until its claim is gone. Delete the claim first.');
      s.volumes.delete(name);
    } else if (kind === 'svc') {
      if (!s.services.delete(name)) { lines.push(...e(notFound('svc', name).message)); continue; }
    } else if (kind === 'sc') {
      const c = s.classes.get(name);
      if (!c) { lines.push(...e(notFound('sc', name).message)); continue; }
      s.classes.delete(name);
    } else throw new CmdError(`sandbox: cannot delete ${kind} here`);
    lines.push(...o(label.replace('statefulset.apps', 'statefulset.apps').replace(/^storageclass\.storage\.k8s\.io/, 'storageclass.storage.k8s.io')));
  }
  if (waits && flags.get('--wait') !== 'false') lines.push(note('(Real kubectl stops here and waits: the claim is still mounted by a running pod, so the pvc-protection finalizer holds it in Terminating until that pod is gone. The sandbox gives you the prompt back.)'));
  return lines;
}

function scale(s: Storage, args: string[]): Out[] {
  const { pos, flags } = parseFlags(args, new Set(['--replicas']), new Set(['--replicas']));
  const t = target(pos);
  if (t.kind !== 'sts') throw new CmdError(`sandbox: only StatefulSets scale in this sandbox.`);
  const n = Number(flags.get('--replicas'));
  if (!flags.has('--replicas') || !Number.isInteger(n) || n < 0) throw new CmdError('error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0');
  const set = s.sets.get(t.names[0]);
  if (!set) throw notFound('sts', t.names[0]);
  set.replicas = n;
  return o(`statefulset.apps/${set.name} scaled`);
}

function patch(s: Storage, args: string[]): Out[] {
  const { pos, flags } = parseFlags(args, new Set(['-p', '--patch', '--type']), new Set(['-p', '--patch', '--type']));
  if (flags.has('--type') && flags.get('--type') !== 'merge' && flags.get('--type') !== 'strategic') throw new CmdError('sandbox: only merge patches (-p \'{"spec":...}\') are modelled here.');
  const t = target(pos);
  const name = t.names[0];
  const raw = flags.get('-p') ?? flags.get('--patch');
  if (!raw) throw new CmdError('error: must specify -p to patch');
  let body: { spec?: Record<string, unknown> };
  try { body = JSON.parse(raw); } catch { throw new CmdError(`error: unable to parse "${raw}": the patch must be JSON, for example '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'`); }
  const spec = body.spec ?? {};
  const keys = Object.keys(body).filter((k) => k !== 'spec');
  if (keys.length) throw new CmdError(`sandbox: patching ${keys.join(', ')} is not modelled here; patch spec.`);
  if (t.kind === 'pv') {
    const v = s.volumes.get(name);
    if (!v) throw notFound('pv', name);
    const other = Object.keys(spec).filter((k) => k !== 'persistentVolumeReclaimPolicy');
    if (other.length) throw new CmdError(`sandbox: only spec.persistentVolumeReclaimPolicy is modelled for a PersistentVolume, not ${other.join(', ')}.`);
    const p = spec.persistentVolumeReclaimPolicy;
    if (p !== 'Retain' && p !== 'Delete') throw new CmdError(`The PersistentVolume "${name}" is invalid: spec.persistentVolumeReclaimPolicy: Unsupported value: "${String(p)}": supported values: "Delete", "Recycle", "Retain"`);
    if (v.reclaim === p) return o(`persistentvolume/${name} patched (no change)`);
    v.reclaim = p;
    return o(`persistentvolume/${name} patched`);
  }
  if (t.kind === 'pvc') {
    const c = s.claims.get(name);
    if (!c) throw notFound('pvc', name);
    throw new CmdError(immutable(name));
  }
  if (t.kind === 'sts') {
    const set = s.sets.get(name);
    if (!set) throw notFound('sts', name);
    const other = Object.keys(spec).filter((k) => k !== 'persistentVolumeClaimRetentionPolicy' && k !== 'replicas');
    if (other.length) throw new CmdError(`sandbox: only spec.persistentVolumeClaimRetentionPolicy and spec.replicas are modelled for a StatefulSet patch, not ${other.join(', ')}.`);
    const r = spec.persistentVolumeClaimRetentionPolicy as Record<string, unknown> | undefined;
    if (r) for (const [k, v] of Object.entries(r)) {
      if (k !== 'whenDeleted' && k !== 'whenScaled') throw new CmdError(`Error from server (BadRequest): strict decoding error: unknown field "spec.persistentVolumeClaimRetentionPolicy.${k}"`);
      if (v !== 'Retain' && v !== 'Delete') throw new CmdError(`The StatefulSet "${name}" is invalid: spec.persistentVolumeClaimRetentionPolicy.${k}: Unsupported value: "${String(v)}": supported values: "Retain", "Delete"`);
      set[k] = v;
    }
    if (spec.replicas !== undefined) { const n = Number(spec.replicas); if (!Number.isInteger(n) || n < 0) throw new CmdError('sandbox: replicas must be a whole number'); set.replicas = n; }
    return o(`statefulset.apps/${name} patched`);
  }
  throw new CmdError(`sandbox: patching ${t.kind} is not modelled here.`);
}

function setImage(s: Storage, args: string[]): Out[] {
  if (args[0] !== 'image') throw new CmdError(`sandbox: kubectl set ${args[0] ?? ''} is not modelled here; kubectl set image sts/<name> app=<image> is.`);
  const pos = args.slice(1);
  const pair = pos.find((a) => a.includes('='));
  const t = target(pos.filter((a) => !a.includes('=')));
  if (t.kind !== 'sts') throw new CmdError('sandbox: only StatefulSets are updated in this sandbox: kubectl set image sts/web app=<image>');
  const set = s.sets.get(t.names[0]);
  if (!set) throw notFound('sts', t.names[0]);
  if (!pair) throw new CmdError('error: at least one image update is required');
  const [ctr, image] = pair.split('=');
  if (ctr !== 'app') throw new CmdError(`error: unable to find container named "${ctr}"`);
  if (!image) throw new CmdError('error: image may not be empty');
  if (set.image !== image) { set.image = image; set.revision++; }
  return o(`statefulset.apps/${set.name} image updated`);
}

function rollout(s: Storage, args: string[]): Out[] {
  if (args[0] !== 'status') throw new CmdError(`sandbox: kubectl rollout ${args[0] ?? ''} is not modelled here; rollout status is.`);
  const { pos } = parseFlags(args.slice(1), new Set(['--timeout']), new Set(['--timeout', '-w', '--watch']));
  const t = target(pos);
  if (t.kind !== 'sts') throw new CmdError('sandbox: rollout status works on sts/<name> here.');
  const set = s.sets.get(t.names[0]);
  if (!set) throw notFound('sts', t.names[0]);
  const pods = [...s.pods.values()].filter((p) => p.owner === set.name && (p.ordinal ?? 0) < set.replicas);
  const notReady = set.replicas - pods.filter((p) => p.ready && p.status === 'Running').length;
  const stale = pods.filter((p) => p.revision !== set.revision).length;
  if (notReady === 0 && stale === 0) return o(`partitioned roll out complete: ${set.replicas} new pods have been updated...`);
  return [...o(stale ? `Waiting for partitioned roll out to finish: ${set.replicas - stale} out of ${set.replicas} new pods have been updated...` : `Waiting for ${notReady} pods to be ready...`),
    note('(The real command keeps watching until the rollout finishes or its --timeout passes. Here it reports once; run it again to see progress.)')];
}

// ---- exec and the node's disk -----------------------------------------------

function exec(s: Storage, args: string[], seen: Seen): Out[] {
  const dd = args.indexOf('--');
  if (dd < 0) throw new CmdError('error: you must specify at least one command for the container, after --');
  const before = args.slice(0, dd).filter((a) => !/^(-it|-ti|-i|-t)$/.test(a));
  if (before.length !== 1) throw new CmdError('sandbox: kubectl exec <pod> -- <command>');
  const pod = s.pods.get(before[0]);
  if (!pod) throw new CmdError(`Error from server (NotFound): pods "${before[0]}" not found`);
  if (pod.status !== 'Running') throw new CmdError(`error: unable to upgrade connection: container not found ("app")`);
  const cmd = args.slice(dd + 1);
  const fileAt = (path: string) => s.podFiles(pod, path);
  if (cmd[0] === 'cat' && cmd.length === 2) {
    const { volume, rel } = fileAt(cmd[1]);
    const text = volume?.files.get(rel);
    if (text === undefined) return [...e(`cat: can't open '${cmd[1]}': No such file or directory`), ...e('command terminated with exit code 1')];
    seen(`read:${pod.name}:${rel}:${text}`);
    return o(text);
  }
  if (cmd[0] === 'ls' && cmd.length <= 2) {
    const path = cmd[1] ?? '/';
    const { volume, rel } = fileAt(path);
    if (!volume || rel) {
      if (path === '/') return o('bin    data   dev    etc    home   proc   root   sys    tmp    usr    var');
      return [...e(`ls: ${path}: No such file or directory`), ...e('command terminated with exit code 1')];
    }
    return o([...volume.files.keys()].sort().join('  '));
  }
  if (cmd[0] === 'sh' && cmd[1] === '-c' && cmd.length === 3) {
    const m = /^\s*echo\s+(?:"([^"]*)"|'([^']*)'|([^>'"]*?))\s*(>>?)\s*(\S+)\s*$/.exec(cmd[2]);
    if (!m) throw new CmdError('sandbox: inside sh -c this pod runs only: echo <text> > <file>  (or >> to append)');
    const text = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    const { volume, rel } = fileAt(m[5]);
    if (!volume || !rel || rel.includes('/')) throw new CmdError(`sandbox: write to a file directly inside a mounted volume, for example ${pod.claims[0]?.mountPath ?? '/data'}/note.txt`);
    const prev = m[4] === '>>' ? (volume.files.get(rel) ?? '') : '';
    volume.files.set(rel, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + text);
    s.written.push({ volume: volume.name, path: rel, text });
    seen(`wrote:${pod.name}`);
    return [];
  }
  throw new CmdError(`sandbox: this pod runs only cat, ls and sh -c "echo ... > file". "${cmd.join(' ')}" is not one of them.`);
}

function docker(s: Storage, args: string[], seen: Seen): Out[] {
  if (args[0] !== 'exec') throw new CmdError('sandbox: only docker exec <node> ls|cat <path> is modelled here.');
  if (args[1] !== NODE) throw new CmdError(`Error response from daemon: No such container: ${args[1] ?? ''}`);
  const [cmd, path] = args.slice(2);
  const base = '/var/local-path-provisioner';
  const vols = [...s.volumes.values()];
  if (cmd === 'ls' && args.length <= 4) {
    if (!path || path === base || path === base + '/') return o(vols.map((v) => s.hostPath(v).slice(base.length + 1)).sort().join('\n'));
    const v = vols.find((x) => s.hostPath(x) === path.replace(/\/$/, ''));
    if (!v) return e(`ls: cannot access '${path}': No such file or directory`);
    return o([...v.files.keys()].sort().join('\n'));
  }
  if (cmd === 'cat' && path) {
    const v = vols.find((x) => path.startsWith(s.hostPath(x) + '/'));
    const text = v?.files.get(path.slice(v ? s.hostPath(v).length + 1 : 0));
    if (text === undefined) return e(`cat: ${path}: No such file or directory`);
    seen(`node-read:${v!.name}`);
    return o(text);
  }
  throw new CmdError(`sandbox: on the node, this sandbox runs ls and cat under ${base} only.`);
}
