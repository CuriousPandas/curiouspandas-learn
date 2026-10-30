// What merge, rebase and squash do to a commit graph. A model of git's
// behaviour, not the git engine: commit names are letters (C, F1, F1'...) so the
// learner can follow them, not hashes. The two claims that matter - a rebase of
// a branch someone built on leaves them duplicate commits, and a squash leaves
// their branch carrying commits main never received - are checked against the
// real git binary in tests/git-strategies.test.ts.

import { parseCommit } from '../delivery/conventional.ts';

export type Lane = 'main' | 'feature' | 'sam';
export type Commit = { id: string; msg: string; parents: string[]; lane: Lane };
export type Scenario = 'solo' | 'shared';
export type Method = 'merge' | 'rebase' | 'squash';

export type Outcome = {
  scenario: Scenario;
  method: Method;
  commits: Commit[];
  main: string[];        // main's first-parent history, newest first
  /** Messages that appear twice in Sam's history after he pulls. */
  samDuplicates: string[];
  /** Commits Sam's next pull request would propose that main has never received as such. */
  samRelists: string[];
  /** What release-please would read on main for this integration. */
  releaseSees: string[];
  squashTitle?: string;
  notes: string[];
};

const FEATURE = [
  { id: 'F1', msg: 'feat(search): filter results by price' },
  { id: 'F2', msg: 'fix(search): keep filters on page reload' },
];

export const SCENARIOS: Record<Scenario, { label: string; detail: string }> = {
  solo: { label: 'Your branch, never pushed', detail: 'Only you have F1 and F2. Meanwhile a teammate merged C to main.' },
  shared: { label: 'Pushed, and Sam built on it', detail: 'You pushed F1 and F2; Sam branched from F2 and committed G. A teammate merged C to main.' },
};

export const SQUASH_TITLES = [
  'feat(search): filter results by price',
  'Update search',
  'WIP',
];

function start(s: Scenario): Commit[] {
  const c: Commit[] = [
    { id: 'A', msg: 'chore: start the shop', parents: [], lane: 'main' },
    { id: 'B', msg: 'feat: list products', parents: ['A'], lane: 'main' },
    { id: 'C', msg: 'fix(cart): round totals', parents: ['B'], lane: 'main' },
    { id: 'F1', msg: FEATURE[0].msg, parents: ['B'], lane: 'feature' },
    { id: 'F2', msg: FEATURE[1].msg, parents: ['F1'], lane: 'feature' },
  ];
  if (s === 'shared') c.push({ id: 'G', msg: 'feat(search): save a filter', parents: ['F2'], lane: 'sam' });
  return c;
}

const ancestors = (commits: Commit[], tip: string): Set<string> => {
  const by = new Map(commits.map((c) => [c.id, c]));
  const seen = new Set<string>(), todo = [tip];
  while (todo.length) { const id = todo.pop()!; if (seen.has(id)) continue; seen.add(id); todo.push(...(by.get(id)?.parents ?? [])); }
  return seen;
};

const firstParent = (commits: Commit[], tip: string): string[] => {
  const by = new Map(commits.map((c) => [c.id, c]));
  const out: string[] = [];
  for (let id: string | undefined = tip; id; id = by.get(id)?.parents[0]) out.push(id);
  return out;
};

export function integrate(scenario: Scenario, method: Method, squashTitle = SQUASH_TITLES[0]): Outcome {
  const commits = start(scenario);
  const notes: string[] = [];
  let mainTip = 'C';
  let samDuplicates: string[] = [];
  let samRelists: string[] = [];
  let releaseSees: string[] = [];

  if (method === 'merge') {
    commits.push({ id: 'M', msg: "Merge branch 'feature'", parents: ['C', 'F2'], lane: 'main' });
    mainTip = 'M';
    releaseSees = FEATURE.map((f) => f.msg);
    notes.push('A merge commit joins the two lines. F1 and F2 keep their ids, so anyone who built on them still matches.');
  } else if (method === 'rebase') {
    // New commits, same changes, on top of C. The originals are abandoned.
    commits.push(
      { id: "F1'", msg: FEATURE[0].msg, parents: ['C'], lane: 'feature' },
      { id: "F2'", msg: FEATURE[1].msg, parents: ["F1'"], lane: 'feature' },
    );
    mainTip = "F2'";
    releaseSees = FEATURE.map((f) => f.msg);
    notes.push("Rebase replayed F1 and F2 on top of C as new commits F1' and F2'. Main fast-forwards: one straight line.");
    if (scenario === 'shared') {
      // Sam's G still sits on the old F2. When he pulls, git merges the old and
      // new copies together: same messages, twice.
      commits.push({ id: 'P', msg: "Merge branch 'feature' of origin", parents: ['G', "F2'"], lane: 'sam' });
      samDuplicates = FEATURE.map((f) => f.msg);
      notes.push("Sam's G was built on the old F2. His pull merged the old and new copies: his log now shows each of your commits twice.");
    }
  } else {
    commits.push({ id: 'S', msg: squashTitle, parents: ['C'], lane: 'main' });
    mainTip = 'S';
    releaseSees = [squashTitle];
    notes.push('Squash put the whole branch into one new commit S on main. F1 and F2 are not in main\'s history at all.');
    if (scenario === 'shared') {
      const inMain = ancestors(commits, mainTip);
      samRelists = [...ancestors(commits, 'G')].filter((id) => !inMain.has(id)).map((id) => commits.find((c) => c.id === id)!.msg).filter((m) => FEATURE.some((f) => f.msg === m));
      notes.push("Sam's branch still contains F1 and F2. Main only has their squashed copy, so his next pull request offers them all over again.");
    }
  }

  if (method === 'squash' && !parseCommit(squashTitle).ok) notes.push(`release-please reads "${squashTitle}" and finds no conventional type: this feature will not reach a release.`);

  return {
    scenario, method, commits, squashTitle: method === 'squash' ? squashTitle : undefined,
    main: firstParent(commits, mainTip),
    samDuplicates, samRelists, releaseSees, notes,
  };
}

/** What release-please would count from this integration: the releasable commit types it sees on main. */
export function releasable(o: Outcome): string[] {
  return o.releaseSees.map(parseCommit).flatMap((p) => (p.ok && ['feat', 'fix', 'deps'].includes(p.commit.type) ? [p.commit.type] : []));
}

/** True when the integration left a teammate with work to untangle. */
export const hurtSam = (o: Outcome) => o.samDuplicates.length > 0 || o.samRelists.length > 0;

/** Rows and lanes for drawing: one row per commit, oldest at the bottom. */
export function layout(o: Outcome) {
  const order = ['A', 'B', 'F1', 'F2', 'C', 'G', "F1'", "F2'", 'S', 'M', 'P'].filter((id) => o.commits.some((c) => c.id === id));
  const rows = new Map(order.map((id, i) => [id, i]));
  return {
    nodes: o.commits.map((c) => ({ ...c, row: rows.get(c.id)!, onMain: o.main.includes(c.id), abandoned: o.method === 'rebase' && (c.id === 'F1' || c.id === 'F2') && o.scenario === 'solo' })),
    edges: o.commits.flatMap((c) => c.parents.map((p) => ({ from: p, to: c.id }))),
    rows: order.length,
  };
}
