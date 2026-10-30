// A toy dependency install, and five ways the code you install stops being
// the code you meant. Each incident is modelled on a real one (named in the
// lesson). The point the table encodes: every control catches some incidents
// and is blind to others, so "we have a lockfile" is not a supply-chain policy.

export type Control = 'lockfile' | 'provenance' | 'review';
export type Verdict = 'blocked' | 'delayed' | 'missed';
export type IncidentId = 'takeover' | 'typosquat' | 'tarball' | 'mirror' | 'token';

export const CONTROLS: Record<Control, { label: string; detail: string }> = {
  lockfile: { label: 'Lockfile + npm ci', detail: 'Install exactly the versions and hashes recorded when the lockfile was written; refuse anything else.' },
  provenance: { label: 'Provenance check', detail: 'Accept a package only if a signed statement says it was built from its public source by its own CI.' },
  review: { label: 'Dependency review', detail: 'A person approves every package name that is new in the dependency diff before it merges.' },
};

export type Incident = {
  id: IncidentId;
  title: string;
  story: string;
  // The package in the tree that turns bad, and how it shows up there.
  target: string;
  arrives: string;
  outcome: Record<Control, { verdict: Verdict; why: string }>;
};

export const INCIDENTS: Incident[] = [
  {
    id: 'takeover', title: 'Maintainer takeover',
    story: 'A new maintainer takes over toy-stream, a package you never chose - it came in under toy-web-kit. Their 3.3.6 adds a new dependency, toy-flatmap, which carries the payload.',
    target: 'toy-flatmap', arrives: 'new transitive package in toy-stream 3.3.6',
    outcome: {
      lockfile: { verdict: 'delayed', why: 'Your lockfile still says toy-stream 3.3.5, so npm ci installs the old one. Until the next routine update - then 3.3.6 comes in with everything else.' },
      provenance: { verdict: 'missed', why: 'toy-flatmap has perfectly valid provenance: it was built by its own CI, from its own repository. The repository is the attacker\'s.' },
      review: { verdict: 'blocked', why: 'The update diff adds a package name nobody has seen before. Somebody has to approve toy-flatmap, and asks why a stream helper needs it.' },
    },
  },
  {
    id: 'typosquat', title: 'Typosquat',
    story: 'Someone adds "toy-cross-envv" to package.json instead of "toy-cross-env". It exists, it works, and its install script mails your environment variables away.',
    target: 'toy-cross-envv', arrives: 'a name you typed',
    outcome: {
      lockfile: { verdict: 'missed', why: 'The lockfile faithfully records exactly what you asked for. You asked for the wrong thing.' },
      provenance: { verdict: 'missed', why: 'The attacker built and signed it properly. Provenance proves where a package came from, not that it is the one you meant.' },
      review: { verdict: 'blocked', why: 'A new name in the diff gets a second pair of eyes: "toy-cross-envv" with two v\'s, 40 downloads, published last week.' },
    },
  },
  {
    id: 'tarball', title: 'Backdoored release tarball',
    story: 'The released tarball of toy-compress 5.6.0 contains a build script that is not in its git repository. The source everyone reviews is clean.',
    target: 'toy-compress', arrives: 'the published artifact differs from the source',
    outcome: {
      lockfile: { verdict: 'missed', why: 'You locked 5.6.0 after it was released, so the lockfile\'s hash is the hash of the backdoored tarball. It checks perfectly.' },
      provenance: { verdict: 'blocked', why: 'The tarball was uploaded from a laptop, not built by the project\'s CI from a tagged commit. There is no provenance linking it to the source, so it is refused.' },
      review: { verdict: 'missed', why: 'Reviewers read the source in git, and the source is clean. The difference is only in the artifact.' },
    },
  },
  {
    id: 'mirror', title: 'Swapped on a mirror',
    story: 'A package mirror your CI uses is compromised. It serves different bytes for toy-pad 1.3.0 - same name, same version. The package is old and publishes no provenance.',
    target: 'toy-pad', arrives: 'same name and version, different bytes',
    outcome: {
      lockfile: { verdict: 'blocked', why: 'The lockfile holds the sha512 of the bytes you first installed. The mirror\'s bytes hash differently and npm ci stops.' },
      provenance: { verdict: 'missed', why: 'This old package never published provenance, so there is nothing to check. Most of a real dependency tree is like this.' },
      review: { verdict: 'missed', why: 'Nothing changed in package.json or in any name - there is no diff to review.' },
    },
  },
  {
    id: 'token', title: 'Stolen publish token',
    story: 'A maintainer\'s npm token leaks from their laptop. The attacker publishes toy-json 2.4.1, a "patch release", straight from their own machine.',
    target: 'toy-json', arrives: 'a new patch version of a package you trust',
    outcome: {
      lockfile: { verdict: 'delayed', why: 'You keep getting 2.4.0 from the lockfile - until a routine update takes 2.4.1, because a patch bump looks harmless.' },
      provenance: { verdict: 'blocked', why: 'Every toy-json release so far was built by its GitHub Actions workflow. 2.4.1 has no provenance from that workflow, so it is refused.' },
      review: { verdict: 'missed', why: 'No new names: just a patch version of a package you already approved. Version bumps of known packages are what reviews wave through.' },
    },
  },
];

// The toy tree. Every name is prefixed toy- on purpose: real package names in
// a lesson about backdoors would accuse real maintainers.
export const TREE: { name: string; depth: number; version: string }[] = [
  { name: 'toy-shop', depth: 0, version: '1.0.0' },
  { name: 'toy-web-kit', depth: 1, version: '4.2.1' },
  { name: 'toy-stream', depth: 2, version: '3.3.5' },
  { name: 'toy-json', depth: 2, version: '2.4.0' },
  { name: 'toy-compress', depth: 1, version: '5.6.0' },
  { name: 'toy-pad', depth: 2, version: '1.3.0' },
  { name: 'toy-cross-env', depth: 1, version: '7.0.3' },
];

export type Row = { name: string; depth: number; version: string; bad?: boolean; added?: boolean };

// The tree as the incident leaves it, before any control runs. Takeover adds a
// package and bumps its parent; a typosquat replaces the name you meant.
export function treeFor(incident: IncidentId): Row[] {
  const rows: Row[] = TREE.map((r) => ({ ...r }));
  const at = (n: string) => rows.findIndex((r) => r.name === n);
  switch (incident) {
    case 'takeover': {
      const i = at('toy-stream');
      rows[i].version = '3.3.6';
      rows.splice(i + 1, 0, { name: 'toy-flatmap', depth: 3, version: '0.1.1', bad: true, added: true });
      break;
    }
    case 'typosquat': Object.assign(rows[at('toy-cross-env')], { name: 'toy-cross-envv', version: '1.0.0', bad: true }); break;
    case 'tarball': rows[at('toy-compress')].bad = true; break;
    case 'mirror': rows[at('toy-pad')].bad = true; break;
    case 'token': Object.assign(rows[at('toy-json')], { version: '2.4.1', bad: true }); break;
  }
  return rows;
}

export type Result = { incident: IncidentId; controls: Control[]; outcome: Verdict; caughtBy: Control | null };

const RANK: Record<Verdict, number> = { blocked: 2, delayed: 1, missed: 0 };

// The best any switched-on control manages. Blocked beats delayed beats missed:
// a delay is not a defence, it is a date.
export function install(incident: IncidentId, controls: Control[]): Result {
  const inc = INCIDENTS.find((i) => i.id === incident);
  if (!inc) throw new Error(`no incident ${incident}`);
  const on = [...new Set(controls)].sort() as Control[];
  let best: Verdict = 'missed', by: Control | null = null;
  for (const c of on) {
    const v = inc.outcome[c].verdict;
    if (RANK[v] > RANK[best]) { best = v; by = c; }
  }
  return { incident, controls: on, outcome: best, caughtBy: by };
}

export const key = (controls: Control[]) => [...new Set(controls)].sort().join('+') || 'none';
