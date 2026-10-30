// Conventional Commits 1.0.0 parsing, the version bump release-please derives
// from it, and the CHANGELOG it groups. Pure functions: the widget and the
// tests drive the same code.
//
// Bump rules are release-please's documented defaults: fix -> patch,
// feat -> minor, a breaking change (`!` or a BREAKING CHANGE footer) -> major,
// and only feat, fix and deps are "releasable units" - a release PR full of
// chores proposes nothing. Changelog headings follow the conventional-changelog
// preset release-please builds on: Features, Bug Fixes and a breaking-changes
// section, with docs/chore/refactor/test/... hidden by default.

export type Commit = {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
  body?: string;
  footers: { token: string; value: string }[];
  /** What the breaking footer says, or the description when only `!` marked it. */
  breakingNote?: string;
};
export type ParseResult = { ok: true; commit: Commit } | { ok: false; error: string };

// type, optional (scope), optional !, then ": " and a description (spec rules 1-5, 13).
const HEADER = /^([A-Za-z][A-Za-z-]*)(?:\(([^()\r\n]*)\))?(!)?(:)?( )?(.*)$/;
// A footer is a token, then ": " or " #", then a value (rule 9). BREAKING CHANGE
// may contain a space and must be uppercase (rules 11, 15); BREAKING-CHANGE is a synonym (rule 16).
const FOOTER = /^(BREAKING CHANGE|BREAKING-CHANGE|[A-Za-z][A-Za-z-]*)(?:: | #)(.*)$/;

export function parseCommit(message: string): ParseResult {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  const header = lines[0].trim();
  if (!header) return { ok: false, error: 'empty message' };
  const m = HEADER.exec(header);
  if (!m || !m[4]) return { ok: false, error: 'no type: a conventional commit starts with a type and a colon, like "fix: ..." or "feat: ..."' };
  const [, rawType, scope, bang, , space, desc] = m;
  if (scope !== undefined && !scope.trim()) return { ok: false, error: 'empty scope: write "fix(api): ..." or leave the brackets out' };
  // "fix: " arrives trimmed to "fix:", so an empty description is checked first.
  if (!desc.trim()) return { ok: false, error: 'no description after the colon' };
  if (!space) return { ok: false, error: 'the colon must be followed by a space: "fix: ...", not "fix:..."' };

  // Body and footers start after one blank line. The footer block is the last
  // paragraph whose first line is a footer token; lines after a footer that are
  // not footers themselves continue its value.
  const rest = lines.slice(1);
  if (rest.length && rest[0].trim() !== '') return { ok: false, error: 'leave one blank line between the first line and the body' };
  const paras = rest.slice(1).join('\n').split(/\n\s*\n/).filter((p) => p.trim());
  const footers: Commit['footers'] = [];
  let bodyParas = paras;
  const last = paras.at(-1);
  if (last && FOOTER.test(last.split('\n')[0])) {
    bodyParas = paras.slice(0, -1);
    for (const line of last.split('\n')) {
      const f = FOOTER.exec(line);
      if (f) footers.push({ token: f[1], value: f[2] });
      else if (footers.length) footers[footers.length - 1].value += `\n${line}`;
    }
  }
  const breakingFooter = footers.find((f) => f.token === 'BREAKING CHANGE' || f.token === 'BREAKING-CHANGE');
  const commit: Commit = {
    // Types are not case-sensitive (rule 15): Fix: and fix: are the same type.
    type: rawType.toLowerCase(),
    scope: scope || undefined,
    breaking: !!bang || !!breakingFooter,
    description: desc.trim(),
    body: bodyParas.length ? bodyParas.join('\n\n') : undefined,
    footers,
  };
  if (commit.breaking) commit.breakingNote = breakingFooter ? breakingFooter.value.trim() : commit.description;
  return { ok: true, commit };
}

export type Bump = 'major' | 'minor' | 'patch';
const RELEASABLE = new Set(['feat', 'fix', 'deps']);

/** The bump a release PR proposes for these commits, or null when nothing is releasable. */
export function bumpFor(commits: Commit[]): Bump | null {
  if (commits.some((c) => c.breaking)) return 'major';
  if (commits.some((c) => c.type === 'feat')) return 'minor';
  if (commits.some((c) => RELEASABLE.has(c.type))) return 'patch';
  return null;
}

export type Version = { major: number; minor: number; patch: number };
export const parseVersion = (v: string): Version => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`not a version: ${v}`);
  return { major: +m[1], minor: +m[2], patch: +m[3] };
};
export const formatVersion = (v: Version) => `${v.major}.${v.minor}.${v.patch}`;

/**
 * SemVer 2.0.0: a minor bump resets patch (rule 7); a major bump resets both
 * (rule 8). Below 1.0.0, release-please's defaults still move a breaking change
 * to 1.0.0; `bumpMinorPreMajor` is its opt-in for staying in 0.y.z.
 */
export function nextVersion(current: string, bump: Bump, opts: { bumpMinorPreMajor?: boolean } = {}): string {
  const v = parseVersion(current);
  if (bump === 'major' && v.major === 0 && opts.bumpMinorPreMajor) bump = 'minor';
  if (bump === 'major') return formatVersion({ major: v.major + 1, minor: 0, patch: 0 });
  if (bump === 'minor') return formatVersion({ major: v.major, minor: v.minor + 1, patch: 0 });
  return formatVersion({ ...v, patch: v.patch + 1 });
}

export type Section = { heading: string; items: string[] };
const HEADINGS: [string, string][] = [['feat', 'Features'], ['fix', 'Bug Fixes']];

/** The CHANGELOG entry a release PR would add, grouped the way the default preset groups it. */
export function changelog(commits: Commit[]): Section[] {
  const line = (c: Commit) => `${c.scope ? `**${c.scope}:** ` : ''}${c.description}`;
  const out: Section[] = [];
  const breaking = commits.filter((c) => c.breaking);
  if (breaking.length) out.push({ heading: '⚠ BREAKING CHANGES', items: breaking.map((c) => `${c.scope ? `**${c.scope}:** ` : ''}${c.breakingNote}`) });
  for (const [type, heading] of HEADINGS) {
    const cs = commits.filter((c) => c.type === type);
    if (cs.length) out.push({ heading, items: cs.map(line) });
  }
  return out;
}

/** Would an npm caret range (the default `npm install` writes) pick this release up automatically? */
export function caretAccepts(range: string, version: string): boolean {
  const base = parseVersion(range.replace(/^\^/, '')), v = parseVersion(version);
  // ^ allows changes that do not modify the left-most non-zero element.
  if (base.major > 0) return v.major === base.major && (v.minor > base.minor || (v.minor === base.minor && v.patch >= base.patch));
  if (base.minor > 0) return v.major === 0 && v.minor === base.minor && v.patch >= base.patch;
  return v.major === 0 && v.minor === 0 && v.patch === base.patch;
}
