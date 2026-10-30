// A repository with release-please watching main. Each change has a truth -
// what the code actually does - and the learner writes the commit message for
// it. The two can disagree, and that is the lesson: release-please trusts the
// message, so a breaking change written as "fix:" ships as a patch, and every
// user on a caret range (npm's default) picks it up automatically.

import { parseCommit, bumpFor, nextVersion, changelog, caretAccepts, type Commit, type Bump, type Section } from './conventional.ts';
import type { Mission } from '../missions.ts';

export type Truth = 'fix' | 'feat' | 'breaking' | 'docs';
export const CHANGES: Record<string, { label: string; truth: Truth; suggest: string }> = {
  typo: { label: 'Fix a typo in an error message', truth: 'fix', suggest: 'fix: correct the typo in the "card declined" message' },
  csv: { label: 'Add a CSV export of orders', truth: 'feat', suggest: 'feat(export): download orders as CSV' },
  // The tempting message: it is a fix to a naming mistake, so "fix:" feels right.
  rename: { label: 'Rename the API field "user" to "account"', truth: 'breaking', suggest: 'fix(api): rename the user field to account' },
  readme: { label: 'Explain the export in the README', truth: 'docs', suggest: 'docs: explain the CSV export' },
};

export type Entry = { change: string; message: string; commit?: Commit; error?: string };
export type ReleaseRecord = { from: string; version: string; bump: Bump; entries: Entry[]; sections: Section[]; brokeUsers: boolean };

export class RepoSim {
  tag = '1.4.2';
  since: Entry[] = [];
  releases: ReleaseRecord[] = [];
  sawIgnored = false;

  commit(change: string, message: string): Entry {
    if (!CHANGES[change]) throw new Error(`unknown change ${change}`);
    const r = parseCommit(message);
    const e: Entry = r.ok ? { change, message, commit: r.commit } : { change, message, error: r.error };
    if (!r.ok) this.sawIgnored = true;
    this.since.push(e);
    return e;
  }

  /** What the open release PR proposes right now. */
  pending() {
    const commits = this.since.flatMap((e) => (e.commit ? [e.commit] : []));
    const bump = bumpFor(commits);
    return { bump, next: bump ? nextVersion(this.tag, bump) : null, sections: changelog(commits), ignored: this.since.filter((e) => !e.commit) };
  }

  /** Merge the release PR: tag, record, and reset. Null when there is nothing releasable. */
  mergeRelease(): ReleaseRecord | null {
    const p = this.pending();
    if (!p.bump || !p.next) return null;
    // Users installed ^<previous tag>. A real breaking change inside a version
    // their range accepts reaches them on their next install - unannounced.
    const breaks = this.since.some((e) => CHANGES[e.change].truth === 'breaking');
    const rec: ReleaseRecord = { from: this.tag, version: p.next, bump: p.bump, entries: this.since, sections: p.sections, brokeUsers: breaks && caretAccepts(`^${this.tag}`, p.next) };
    this.releases.push(rec);
    this.tag = p.next;
    this.since = [];
    return rec;
  }

  shippedBreakingSafely(): boolean {
    return this.releases.some((r) => r.bump === 'major' && !r.brokeUsers
      && r.entries.some((e) => CHANGES[e.change].truth === 'breaking' && e.commit?.breaking));
  }
}

export type ReleaseAutoState = { repo: RepoSim };

export const RELEASE_AUTO_MISSION: Mission<ReleaseAutoState> = {
  id: 'release-please', title: 'Let the messages cut the release', xp: 60,
  setup: () => ({ repo: new RepoSim() }),
  steps: [
    { text: 'Fix the typo, commit it, and merge the release PR it opens', hint: 'Change: the typo. Keep the suggested "fix:" message, Commit, then Merge release PR', done: (s) => s.repo.releases.some((r) => r.bump === 'patch') },
    { text: 'Commit "Fixed stuff" and see what the release PR makes of it', hint: 'Any change, message: Fixed stuff', done: (s) => s.repo.sawIgnored },
    { text: 'Ship the CSV export as a feature', hint: 'A feat: commit makes the release PR propose a minor version', done: (s) => s.repo.releases.some((r) => r.bump === 'minor' && r.entries.some((e) => e.change === 'csv' && e.commit?.type === 'feat')) },
    { text: 'Ship the API rename without breaking anyone who installed your package with ^', hint: 'The suggested "fix:" message ships a patch that ^ ranges take automatically. What marks a commit as breaking?', done: (s) => s.repo.shippedBreakingSafely() },
  ],
  debrief: 'release-please never read your code - only your messages. "fix:" on a renamed field shipped a patch, and every project on a caret range installed it on its next build. One "!" (or a BREAKING CHANGE footer) turned the same code into a major version that nobody gets by accident, with the break written at the top of the changelog. The commit message is the release note.',
};
