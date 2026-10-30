// A toy Kubernetes authoriser: Roles, ClusterRoles and their bindings, and the
// question every request asks - may this subject do this verb to this thing?
// Rules follow the RBAC docs: permissions are purely additive (no deny), a Role
// lives in one namespace, and a RoleBinding to a ClusterRole grants it only in
// the binding's namespace. API groups are left out: every resource here is core.

// Type-only: the engine stays free of the DOM so node --test can run it.
import type { TermLine } from '../ui.ts';

export type Rule = { verbs: string[]; resources: string[]; resourceNames?: string[] };
export type Role = { kind: 'Role' | 'ClusterRole'; name: string; namespace?: string; rules: Rule[] };
export type Binding = { kind: 'RoleBinding' | 'ClusterRoleBinding'; name: string; namespace?: string; roleKind: 'Role' | 'ClusterRole'; role: string; subject: string };
export type Ask = { subject: string; verb: string; resource: string; namespace: string; name?: string };

// The three built-in roles the lesson leans on, reduced to what matters here.
// view deliberately omits secrets, as the real one does: reading a Secret can
// hand you another service account's credentials.
const VIEWABLE = ['pods', 'services', 'configmaps', 'deployments', 'events'];
export const BUILTIN: Role[] = [
  { kind: 'ClusterRole', name: 'cluster-admin', rules: [{ verbs: ['*'], resources: ['*'] }] },
  { kind: 'ClusterRole', name: 'edit', rules: [{ verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'], resources: [...VIEWABLE, 'secrets'] }] },
  { kind: 'ClusterRole', name: 'view', rules: [{ verbs: ['get', 'list', 'watch'], resources: VIEWABLE }] },
];

export const RESOURCES = ['pods', 'services', 'configmaps', 'secrets', 'deployments', 'events', 'roles', 'rolebindings'];
export const VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'];
const PLURAL: Record<string, string> = { pod: 'pods', service: 'services', svc: 'services', configmap: 'configmaps', cm: 'configmaps', secret: 'secrets', deployment: 'deployments', deploy: 'deployments', event: 'events', role: 'roles', rolebinding: 'rolebindings' };
export const plural = (r: string) => PLURAL[r] ?? r;

export class Authz {
  roles: Role[] = [...BUILTIN];
  bindings: Binding[] = [];

  role(kind: Role['kind'], name: string, ns?: string) {
    return this.roles.find((r) => r.kind === kind && r.name === name && (kind === 'ClusterRole' || r.namespace === ns));
  }

  // Which binding (if any) lets this request through. The first match is
  // reported so the learner can see *why* something is allowed.
  explain(a: Ask): { allowed: boolean; via?: Binding } {
    for (const b of this.bindings) {
      if (b.subject !== a.subject) continue;
      if (b.kind === 'RoleBinding' && b.namespace !== a.namespace) continue;
      const role = this.role(b.roleKind, b.role, b.namespace);
      if (!role) continue; // a binding to a missing role grants nothing - and says nothing
      if (role.rules.some((r) => matches(r, a))) return { allowed: true, via: b };
    }
    return { allowed: false };
  }

  can(a: Ask) { return this.explain(a).allowed; }
}

function matches(r: Rule, a: Ask) {
  const verb = r.verbs.includes('*') || r.verbs.includes(a.verb);
  const res = r.resources.includes('*') || r.resources.includes(a.resource);
  // resourceNames narrows a rule to named objects. A request without a name
  // (list, or create) can never match a named rule.
  const name = !r.resourceNames?.length || (a.name !== undefined && r.resourceNames.includes(a.name));
  return verb && res && name;
}

export const saSubject = (ns: string, sa: string) => `system:serviceaccount:${ns}:${sa}`;

// ---- a kubectl-shaped front end ------------------------------------------

export type Line = TermLine;
const err = (text: string): Line[] => [{ text, kind: 'err' }];

function flags(args: string[]) {
  const pos: string[] = [];
  const f: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      (f[k] ??= []).push(...(v ?? args[++i] ?? '').split(',').filter(Boolean));
    } else if (a === '-n') (f.namespace ??= []).push(args[++i] ?? '');
    else pos.push(a);
  }
  return { pos, f };
}

export function kubectlAuth(z: Authz, line: string, defaultNs = 'default'): Line[] {
  const t = line.trim().split(/\s+/).filter(Boolean);
  if (t[0] !== 'kubectl') return err(`${t[0] ?? ''}: command not found. This sandbox understands kubectl auth, create, get, describe and delete.`);
  const { pos, f } = flags(t.slice(1));
  const ns = f.namespace?.[0] ?? defaultNs;
  const [cmd, sub, ...rest] = pos;

  if (cmd === 'auth' && sub === 'can-i') {
    const [verb, target] = rest;
    if (!verb || !target) return err('usage: kubectl auth can-i <verb> <resource>[/<name>] -n <namespace> --as=system:serviceaccount:<ns>:<name>');
    const [r, name] = target.split('/');
    const subject = f.as?.[0];
    if (!subject) return err('This sandbox has no user of its own - add --as=system:serviceaccount:<namespace>:<name> to ask on behalf of the app.');
    return [{ text: z.can({ subject, verb, resource: plural(r), namespace: ns, name }) ? 'yes' : 'no', kind: 'out' }];
  }

  if (cmd === 'create' && sub === 'role') {
    const [name] = rest;
    if (!name || !f.verb || !f.resource) return err('usage: kubectl create role <name> --verb=get --resource=configmaps [--resource-name=<name>] -n <namespace>');
    if (z.role('Role', name, ns)) return err(`Error from server (AlreadyExists): roles.rbac.authorization.k8s.io "${name}" already exists`);
    const bad = f.verb.find((v) => !VERBS.includes(v) && v !== '*');
    if (bad) return err(`error: invalid verb '${bad}'`);
    z.roles.push({ kind: 'Role', name, namespace: ns, rules: [{ verbs: f.verb, resources: f.resource.map(plural), resourceNames: f['resource-name'] }] });
    return [{ text: `role.rbac.authorization.k8s.io/${name} created`, kind: 'out' }];
  }

  if (cmd === 'create' && (sub === 'rolebinding' || sub === 'clusterrolebinding')) {
    const [name] = rest;
    const sa = f.serviceaccount?.[0];
    const roleRef = f.role?.[0] ? { roleKind: 'Role' as const, role: f.role[0] } : f.clusterrole?.[0] ? { roleKind: 'ClusterRole' as const, role: f.clusterrole[0] } : null;
    if (!name || !sa || !roleRef || !sa.includes(':')) return err(`usage: kubectl create ${sub} <name> --${sub === 'rolebinding' ? 'role=<role>|--clusterrole=<role>' : 'clusterrole=<role>'} --serviceaccount=<namespace>:<name>${sub === 'rolebinding' ? ' -n <namespace>' : ''}`);
    if (sub === 'clusterrolebinding' && roleRef.roleKind === 'Role') return err('error: a ClusterRoleBinding can only refer to a ClusterRole');
    const kind = sub === 'rolebinding' ? 'RoleBinding' : 'ClusterRoleBinding';
    if (z.bindings.some((b) => b.kind === kind && b.name === name && (kind === 'ClusterRoleBinding' || b.namespace === ns))) return err(`Error from server (AlreadyExists): ${sub}s.rbac.authorization.k8s.io "${name}" already exists`);
    const [sNs, sName] = sa.split(':');
    z.bindings.push({ kind, name, namespace: kind === 'RoleBinding' ? ns : undefined, ...roleRef, subject: saSubject(sNs, sName) });
    const out: Line[] = [{ text: `${sub}.rbac.authorization.k8s.io/${name} created`, kind: 'out' }];
    // Real Kubernetes accepts a binding to a role that does not exist yet, and
    // it grants nothing. Say so, or the learner reads the success as a grant.
    if (!z.role(roleRef.roleKind, roleRef.role, ns)) out.push({ text: `(note: ${roleRef.roleKind} "${roleRef.role}" does not exist${roleRef.roleKind === 'Role' ? ` in namespace ${ns}` : ''} - this binding grants nothing until it does)`, kind: 'dim' });
    return out;
  }

  if (cmd === 'get') {
    const what = (sub ?? '').split(',');
    const out: Line[] = [];
    for (const w of what) {
      if (/^roles?$/.test(w)) {
        const rs = z.roles.filter((r) => r.kind === 'Role' && r.namespace === ns);
        out.push(...(rs.length ? [{ text: 'NAME', kind: 'dim' as const }, ...rs.map((r) => ({ text: r.name, kind: 'out' as const }))] : [{ text: `No roles found in ${ns} namespace.`, kind: 'dim' as const }]));
      } else if (/^rolebindings?$/.test(w)) {
        const bs = z.bindings.filter((b) => b.kind === 'RoleBinding' && b.namespace === ns);
        out.push(...(bs.length ? [{ text: 'NAME                ROLE', kind: 'dim' as const }, ...bs.map((b) => ({ text: `${b.name.padEnd(20)}${b.roleKind}/${b.role}`, kind: 'out' as const }))] : [{ text: `No rolebindings found in ${ns} namespace.`, kind: 'dim' as const }]));
      } else if (/^clusterrolebindings?$/.test(w)) {
        const bs = z.bindings.filter((b) => b.kind === 'ClusterRoleBinding');
        out.push(...(bs.length ? [{ text: 'NAME                ROLE', kind: 'dim' as const }, ...bs.map((b) => ({ text: `${b.name.padEnd(20)}ClusterRole/${b.role}`, kind: 'out' as const }))] : [{ text: 'No clusterrolebindings found (the built-in ones are hidden here).', kind: 'dim' as const }]));
      } else return err(`error: the server doesn't have a resource type "${w}" in this sandbox - try roles, rolebindings or clusterrolebindings`);
    }
    return out;
  }

  if (cmd === 'describe' && (sub === 'role' || sub === 'clusterrole')) {
    const r = z.role(sub === 'role' ? 'Role' : 'ClusterRole', rest[0] ?? '', ns);
    if (!r) return err(`Error from server (NotFound): ${sub}s.rbac.authorization.k8s.io "${rest[0] ?? ''}" not found`);
    return [
      { text: `Name:  ${r.name}`, kind: 'out' },
      { text: 'Resources    Resource Names    Verbs', kind: 'dim' },
      ...r.rules.map((x) => ({ text: `${x.resources.join(',').padEnd(13)}${(x.resourceNames?.length ? `[${x.resourceNames.join(' ')}]` : '[]').padEnd(18)}[${x.verbs.join(' ')}]`, kind: 'out' as const })),
    ];
  }

  if (cmd === 'delete' && ['role', 'rolebinding', 'clusterrolebinding'].includes(sub ?? '')) {
    const name = rest[0];
    if (sub === 'role') {
      const i = z.roles.findIndex((r) => r.kind === 'Role' && r.name === name && r.namespace === ns);
      if (i < 0) return err(`Error from server (NotFound): roles.rbac.authorization.k8s.io "${name}" not found`);
      z.roles.splice(i, 1);
    } else {
      const kind = sub === 'rolebinding' ? 'RoleBinding' : 'ClusterRoleBinding';
      const i = z.bindings.findIndex((b) => b.kind === kind && b.name === name && (kind === 'ClusterRoleBinding' || b.namespace === ns));
      if (i < 0) return err(`Error from server (NotFound): ${sub}s.rbac.authorization.k8s.io "${name}" not found`);
      z.bindings.splice(i, 1);
    }
    return [{ text: `${sub}.rbac.authorization.k8s.io "${name}" deleted`, kind: 'out' }];
  }

  if (cmd === 'help' || t.length === 1) return HELP;
  return err(`This sandbox does not model "kubectl ${[cmd, sub].filter(Boolean).join(' ')}". Type kubectl help.`);
}

const HELP: Line[] = [
  { text: 'kubectl auth can-i get configmaps/shop-settings -n shop --as=system:serviceaccount:shop:reporter', kind: 'dim' },
  { text: 'kubectl create role <name> --verb=get --resource=configmaps --resource-name=<name> -n shop', kind: 'dim' },
  { text: 'kubectl create rolebinding <name> --role=<role> --serviceaccount=shop:reporter -n shop', kind: 'dim' },
  { text: 'kubectl create clusterrolebinding <name> --clusterrole=cluster-admin --serviceaccount=shop:reporter', kind: 'dim' },
  { text: 'kubectl get roles,rolebindings -n shop  ·  kubectl get clusterrolebindings', kind: 'dim' },
  { text: 'kubectl describe role <name> -n shop  ·  kubectl delete rolebinding|clusterrolebinding|role <name>', kind: 'dim' },
];

// ---- the least-privilege audit the mission grades on ---------------------

export const APP = { ns: 'shop', sa: 'reporter', cm: 'shop-settings' };
export const APP_SUBJECT = saSubject(APP.ns, APP.sa);

export type Check = { id: string; text: string; want: boolean; got: boolean };

// The app needs exactly one thing. Everything else on this list is a door that
// a stolen token from this pod would open.
export function audit(z: Authz): Check[] {
  const ask = (verb: string, resource: string, namespace: string, name?: string) => z.can({ subject: APP_SUBJECT, verb, resource, namespace, name });
  return [
    { id: 'works', text: 'reads ConfigMap shop-settings in shop (the app needs this)', want: true, got: ask('get', 'configmaps', APP.ns, APP.cm) },
    { id: 'secrets', text: 'cannot read Secrets in shop', want: false, got: ask('get', 'secrets', APP.ns, 'db-password') },
    { id: 'write', text: 'cannot change shop-settings', want: false, got: ask('update', 'configmaps', APP.ns, APP.cm) || ask('delete', 'configmaps', APP.ns, APP.cm) },
    { id: 'others', text: 'cannot read other ConfigMaps in shop', want: false, got: ask('get', 'configmaps', APP.ns, 'payment-keys') || ask('list', 'configmaps', APP.ns) },
    { id: 'elsewhere', text: 'cannot read anything in kube-system', want: false, got: ask('get', 'configmaps', 'kube-system', 'kube-proxy') || ask('get', 'secrets', 'kube-system', 'bootstrap-token') },
  ];
}
