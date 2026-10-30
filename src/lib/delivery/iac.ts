// A toy infrastructure-as-code engine with the three things real tools keep
// apart: the configuration (what you wrote), the state (what the tool last
// did) and the cloud (what actually exists). A plan reads the cloud, compares
// it with the configuration, and proposes actions - the same three steps the
// OpenTofu plan docs list. Drift is the cloud no longer matching the state.
//
// Action symbols follow Terraform/OpenTofu plans: + create, ~ update in-place,
// -/+ replace (destroy, then create), - destroy. Replacement is driven by
// fields the "API" cannot change in place, and it changes the object's id and
// address - so anything pointing at it must be updated in the same plan.

export type Kind = 'bucket' | 'server' | 'dns';
export type Attrs = Record<string, string>;
export type Desired = { bucket?: Attrs; server?: Attrs; dns?: Attrs };
type Obj = { id: string; attrs: Attrs };
export type Action = 'create' | 'update' | 'replace' | 'destroy';
export type Change = { kind: Kind; action: Action; fields: { name: string; from?: string; to?: string; forces?: boolean }[]; drift: boolean };
export type Plan = { changes: Change[]; drifted: Kind[]; basedOn: number };

export const ADDRESS: Record<Kind, string> = { bucket: 'bucket.assets', server: 'server.web', dns: 'dns_record.www' };
// Fields the toy cloud API cannot change on a live object. Changing one means
// a new object - as with a server's base image on most real clouds.
export const FORCES_NEW: Record<Kind, string[]> = { bucket: ['name'], server: ['image'], dns: ['name'] };
const ORDER: Kind[] = ['bucket', 'server', 'dns'];

export const START: Desired = {
  bucket: { name: 'panda-assets', versioning: 'off' },
  server: { size: 'small', image: 'ubuntu-24.04' },
  dns: { name: 'www.panda.toy', points_to: '${server.web.ip}' },
};

export class Cloud {
  objects = new Map<Kind, Obj>();
  private next = 1;
  newId(kind: Kind) { return `${kind === 'dns' ? 'rec' : kind === 'server' ? 'i' : 'bkt'}-${(this.next++).toString(16).padStart(4, '0')}`; }
  ipOf(id: string) { return `10.0.0.${(parseInt(id.split('-')[1], 16) % 200) + 10}`; }
}

export class Engine {
  desired: Desired = structuredClone(START);
  /** What the tool believes exists, as of its last apply. */
  state = new Map<Kind, Obj>();
  cloud = new Cloud();
  /** Bumped whenever the configuration or the cloud changes, so a stale plan cannot be applied. */
  version = 0;
  lastPlan?: Plan;
  history: { event: 'plan' | 'apply' | 'console' | 'edit'; plan?: Plan; detail?: string }[] = [];

  /** Resolve references like ${server.web.ip} against what will exist. */
  private resolve(kind: Kind, attrs: Attrs, serverId?: string): Attrs {
    const out = { ...attrs };
    if (kind === 'dns' && out.points_to === '${server.web.ip}') out.points_to = serverId ? this.cloud.ipOf(serverId) : '(known after apply)';
    return out;
  }

  edit(kind: Kind, attrs: Attrs | undefined) {
    if (attrs) this.desired[kind] = { ...attrs }; else delete this.desired[kind];
    this.version++;
    this.history.push({ event: 'edit', detail: `${ADDRESS[kind]} ${attrs ? 'changed' : 'removed'}` });
  }

  /** A change made by hand in the cloud console: the tool is not told. */
  console(kind: Kind, field: string, value: string) {
    const o = this.cloud.objects.get(kind);
    if (!o) return false;
    o.attrs = { ...o.attrs, [field]: value };
    this.version++;
    this.history.push({ event: 'console', detail: `${ADDRESS[kind]}.${field} = ${value}` });
    return true;
  }

  plan(): Plan {
    const changes: Change[] = [];
    const drifted: Kind[] = [];
    let serverReplaced = false;
    for (const kind of ORDER) {
      const want = this.desired[kind];
      const stateObj = this.state.get(kind);
      const real = this.cloud.objects.get(kind);
      // Refresh: compare what the tool last did with what is really there.
      const drift = !!stateObj && (!real || JSON.stringify(real.attrs) !== JSON.stringify(stateObj.attrs));
      if (drift) drifted.push(kind);
      if (!want) { if (real) changes.push({ kind, action: 'destroy', fields: Object.entries(real.attrs).map(([name, from]) => ({ name, from })), drift }); continue; }
      if (!real) { changes.push({ kind, action: 'create', fields: Object.entries(this.resolve(kind, want, undefined)).map(([name, to]) => ({ name, to })), drift }); if (kind === 'server') serverReplaced = true; continue; }
      const target = this.resolve(kind, want, kind === 'dns' && serverReplaced ? undefined : this.cloud.objects.get('server')?.id);
      const fields = Object.keys({ ...real.attrs, ...target }).filter((k) => real.attrs[k] !== target[k])
        .map((name) => ({ name, from: real.attrs[name], to: target[name], forces: FORCES_NEW[kind].includes(name) }));
      if (!fields.length) continue;
      const replace = fields.some((f) => f.forces);
      if (replace && kind === 'server') serverReplaced = true;
      changes.push({ kind, action: replace ? 'replace' : 'update', fields, drift });
    }
    const plan = { changes, drifted, basedOn: this.version };
    this.lastPlan = plan;
    this.history.push({ event: 'plan', plan });
    return plan;
  }

  /** Apply the last plan. Refuses a plan made before anything changed. */
  apply(): { ok: boolean; message: string } {
    const plan = this.lastPlan;
    if (!plan) return { ok: false, message: 'Run a plan first: apply carries out a plan you have read.' };
    if (plan.basedOn !== this.version) return { ok: false, message: 'Something changed since that plan. Plan again and read the new one.' };
    for (const c of plan.changes) {
      if (c.action === 'destroy') { this.cloud.objects.delete(c.kind); this.state.delete(c.kind); continue; }
      if (c.action === 'create' || c.action === 'replace') {
        this.cloud.objects.delete(c.kind);
        const id = this.cloud.newId(c.kind);
        const obj = { id, attrs: this.resolve(c.kind, this.desired[c.kind]!, c.kind === 'dns' ? this.cloud.objects.get('server')?.id : undefined) };
        this.cloud.objects.set(c.kind, obj);
        this.state.set(c.kind, structuredClone(obj));
        continue;
      }
      const real = this.cloud.objects.get(c.kind)!;
      real.attrs = this.resolve(c.kind, this.desired[c.kind]!, this.cloud.objects.get('server')?.id);
      this.state.set(c.kind, structuredClone(real));
    }
    // Anything the plan did not touch is refreshed into state, as a real apply does.
    for (const [k, o] of this.cloud.objects) if (!plan.changes.some((c) => c.kind === k)) this.state.set(k, structuredClone(o));
    this.version++;
    this.lastPlan = undefined;
    this.history.push({ event: 'apply', plan });
    const n = (a: Action) => plan.changes.filter((c) => c.action === a).length;
    const add = n('create') + n('replace'), destroy = n('destroy') + n('replace');
    return { ok: true, message: `Apply complete. ${add} added, ${n('update')} changed, ${destroy} destroyed.` };
  }
}

export const SYMBOL: Record<Action, string> = { create: '+', update: '~', replace: '-/+', destroy: '-' };

/** Plan output as plain lines, in the shape of a Terraform/OpenTofu plan (not a copy of it). */
export function render(plan: Plan): { text: string; kind: 'add' | 'change' | 'replace' | 'destroy' | 'note' | 'plain' }[] {
  const out: ReturnType<typeof render> = [];
  if (plan.drifted.length) {
    out.push({ text: `Changed outside the tool since the last apply: ${plan.drifted.map((k) => ADDRESS[k]).join(', ')}`, kind: 'note' });
    out.push({ text: '', kind: 'plain' });
  }
  if (!plan.changes.length) { out.push({ text: 'No changes. The cloud matches the configuration.', kind: 'plain' }); return out; }
  const style = { create: 'add', update: 'change', replace: 'replace', destroy: 'destroy' } as const;
  for (const c of plan.changes) {
    const verb = { create: 'will be created', update: 'will be updated in-place', replace: 'must be replaced', destroy: 'will be destroyed' }[c.action];
    out.push({ text: `# ${ADDRESS[c.kind]} ${verb}`, kind: style[c.action] });
    for (const f of c.fields) {
      const line = c.action === 'create' ? `    + ${f.name} = "${f.to}"`
        : c.action === 'destroy' ? `    - ${f.name} = "${f.from}"`
        : `    ~ ${f.name} = "${f.from ?? ''}" -> "${f.to ?? ''}"${f.forces ? '   # forces replacement' : ''}`;
      out.push({ text: line, kind: style[c.action] });
    }
  }
  const n = (a: Action) => plan.changes.filter((c) => c.action === a).length;
  out.push({ text: '', kind: 'plain' });
  out.push({ text: `Plan: ${n('create') + n('replace')} to add, ${n('update')} to change, ${n('destroy') + n('replace')} to destroy.`, kind: 'plain' });
  return out;
}
