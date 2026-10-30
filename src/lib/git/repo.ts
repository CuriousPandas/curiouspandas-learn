// A small git that stores objects exactly the way real git does, so every hash
// a learner sees here is the hash git would print for the same files, author and
// time. That is the point of the playground: "content addressing" stops being a
// phrase when `git hash-object` on your laptop prints the number you saw here.
// tests/git-parity.test.ts replays scripts through both and compares hashes.

import { sha1 } from './sha1.ts';
import { merge3, splitLines, diffLines } from './diff.ts';

const enc = new TextEncoder();

export type Person = { name: string; email: string; time: number; tz: string };
export type TreeEntry = { mode: '100644' | '40000'; name: string; sha: string };
export type GitObject =
  | { type: 'blob'; data: string }
  | { type: 'tree'; entries: TreeEntry[] }
  | { type: 'commit'; tree: string; parents: string[]; author: Person; committer: Person; message: string };

export type Head = { kind: 'branch'; name: string } | { kind: 'detached'; sha: string };

export class GitError extends Error {}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function personLine(p: Person) { return `${p.name} <${p.email}> ${p.time} ${p.tz}`; }

/** The exact bytes git hashes: "<type> <size>\0<body>". */
export function serialize(obj: GitObject): Uint8Array {
  let body: Uint8Array;
  if (obj.type === 'blob') body = enc.encode(obj.data);
  else if (obj.type === 'tree') {
    body = concat(obj.entries.flatMap((e) => [enc.encode(`${e.mode} ${e.name}\0`), hexToBytes(e.sha)]));
  } else body = enc.encode(commitText(obj));
  return concat([enc.encode(`${obj.type} ${body.length}\0`), body]);
}

function commitText(c: Extract<GitObject, { type: 'commit' }>) {
  return [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`),
    `author ${personLine(c.author)}`, `committer ${personLine(c.committer)}`, '', c.message].join('\n');
}

export function hashOf(obj: GitObject) { return sha1(serialize(obj)); }

// git sorts tree entries by name, but compares a directory as if its name ended
// in "/". Sorting plainly gives a different tree hash as soon as a file named
// "a.txt" sits next to a directory named "a".
function treeKey(e: TreeEntry) { return e.mode === '40000' ? e.name + '/' : e.name; }

export type RepoOptions = { clock?: () => { time: number; tz: string }; user?: { name: string; email: string } };

export function localClock() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return { time: Math.floor(d.getTime() / 1000), tz: `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}` };
}

export class Repo {
  initialized = false;
  workdir = new Map<string, string>();
  index = new Map<string, string>();
  objects = new Map<string, GitObject>();
  branches = new Map<string, string>();
  head: Head = { kind: 'branch', name: 'main' };
  merging: { theirs: string; label: string; conflicts: Set<string> } | null = null;
  user: { name: string; email: string };
  clock: () => { time: number; tz: string };

  constructor(opts: RepoOptions = {}) {
    this.clock = opts.clock ?? localClock;
    this.user = opts.user ?? { name: 'Curious Panda', email: 'panda@curiouspandas.dev' };
  }

  // ---- objects -----------------------------------------------------------

  write(obj: GitObject): string {
    const sha = hashOf(obj);
    if (!this.objects.has(sha)) this.objects.set(sha, obj);
    return sha;
  }

  get(sha: string): GitObject {
    const o = this.objects.get(sha);
    if (!o) throw new GitError(`fatal: Not a valid object name ${sha}`);
    return o;
  }

  commit(sha: string) {
    const o = this.get(sha);
    if (o.type !== 'commit') throw new GitError(`fatal: ${sha.slice(0, 7)} is not a commit`);
    return o;
  }

  /** Full sha from a branch name, HEAD, or an unambiguous prefix of 4+ chars,
   *  optionally followed by ~N (Nth first-parent ancestor) and ^N (Nth parent). */
  resolve(rev: string): string {
    // Ref names may not contain ~ or ^, so anything after the first one is a walk.
    const walk = /^([^~^]+)((?:[~^]\d*)+)$/.exec(rev);
    if (walk) {
      let sha = this.resolve(walk[1]);
      for (const [, op, digits] of walk[2].matchAll(/([~^])(\d*)/g)) {
        const n = digits === '' ? 1 : Number(digits);
        const steps = op === '~' ? n : n === 0 ? 0 : 1;
        for (let i = 0; i < steps; i++) {
          const parent = this.commit(sha).parents[op === '~' ? 0 : n - 1];
          if (!parent) throw new GitError(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
          sha = parent;
        }
      }
      return sha;
    }
    if (rev === 'HEAD') {
      const h = this.headSha();
      if (!h) throw new GitError(`fatal: ambiguous argument 'HEAD': unknown revision`);
      return h;
    }
    const b = this.branches.get(rev);
    if (b) return b;
    if (/^[0-9a-f]{4,40}$/.test(rev)) {
      const hits = [...this.objects.keys()].filter((k) => k.startsWith(rev));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new GitError(`error: short object ID ${rev} is ambiguous`);
    }
    throw new GitError(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
  }

  headSha(): string | undefined {
    return this.head.kind === 'branch' ? this.branches.get(this.head.name) : this.head.sha;
  }

  /** Flatten a tree into path -> blob sha. */
  flatten(treeSha: string | undefined, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    if (!treeSha) return out;
    const t = this.get(treeSha);
    if (t.type !== 'tree') throw new GitError('fatal: not a tree');
    for (const e of t.entries) {
      if (e.mode === '40000') for (const [p, s] of this.flatten(e.sha, prefix + e.name + '/')) out.set(p, s);
      else out.set(prefix + e.name, e.sha);
    }
    return out;
  }

  treeOfCommit(sha: string | undefined) { return sha ? this.flatten(this.commit(sha).tree) : new Map<string, string>(); }

  /** Build nested tree objects from a flat path -> blob map; returns root tree sha. */
  writeTree(files: Map<string, string>): string {
    const build = (paths: [string, string][]): string => {
      const direct: TreeEntry[] = [];
      const dirs = new Map<string, [string, string][]>();
      for (const [p, s] of paths) {
        const slash = p.indexOf('/');
        if (slash < 0) direct.push({ mode: '100644', name: p, sha: s });
        else {
          const d = p.slice(0, slash);
          if (!dirs.has(d)) dirs.set(d, []);
          dirs.get(d)!.push([p.slice(slash + 1), s]);
        }
      }
      for (const [d, sub] of dirs) direct.push({ mode: '40000', name: d, sha: build(sub) });
      direct.sort((x, y) => (treeKey(x) < treeKey(y) ? -1 : treeKey(x) > treeKey(y) ? 1 : 0));
      return this.write({ type: 'tree', entries: direct });
    };
    return build([...files]);
  }

  blobSha(content: string) { return hashOf({ type: 'blob', data: content }); }

  // ---- history -----------------------------------------------------------

  ancestors(sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...this.commit(s).parents);
    }
    return seen;
  }

  isAncestor(maybe: string, of: string) { return this.ancestors(of).has(maybe); }

  /** Best common ancestor: the shared ancestor with the newest commit time. */
  mergeBase(a: string, b: string): string | undefined {
    const ours = this.ancestors(a);
    let best: string | undefined;
    for (const s of this.ancestors(b)) {
      if (!ours.has(s)) continue;
      if (!best || this.commit(s).committer.time > this.commit(best).committer.time ||
        this.isAncestor(best, s)) best = s;
    }
    return best;
  }

  /** Every commit reachable from any branch or HEAD, newest first. */
  allCommits(): string[] {
    const seen = new Set<string>();
    const tips = [...this.branches.values()];
    const h = this.headSha();
    if (h) tips.push(h);
    for (const t of tips) for (const s of this.ancestors(t)) seen.add(s);
    const order = [...this.objects.keys()];
    return [...seen].sort((x, y) => {
      const d = this.commit(y).committer.time - this.commit(x).committer.time;
      return d !== 0 ? d : order.indexOf(y) - order.indexOf(x);
    });
  }

  // ---- working tree status ----------------------------------------------

  status() {
    const head = this.treeOfCommit(this.headSha());
    const staged: { path: string; kind: 'new file' | 'modified' | 'deleted' }[] = [];
    const unstaged: { path: string; kind: 'modified' | 'deleted' }[] = [];
    const untracked: string[] = [];
    for (const [p, s] of this.index) {
      if (!head.has(p)) staged.push({ path: p, kind: 'new file' });
      else if (head.get(p) !== s) staged.push({ path: p, kind: 'modified' });
    }
    for (const p of head.keys()) if (!this.index.has(p)) staged.push({ path: p, kind: 'deleted' });
    for (const [p, s] of this.index) {
      if (!this.workdir.has(p)) unstaged.push({ path: p, kind: 'deleted' });
      else if (this.blobSha(this.workdir.get(p)!) !== s || this.merging?.conflicts.has(p)) {
        unstaged.push({ path: p, kind: 'modified' });
      }
    }
    for (const p of this.workdir.keys()) if (!this.index.has(p)) untracked.push(p);
    const by = (x: { path: string }, y: { path: string }) => x.path.localeCompare(y.path);
    return { staged: staged.sort(by), unstaged: unstaged.sort(by), untracked: untracked.sort() };
  }

  // ---- porcelain ---------------------------------------------------------

  init(): string {
    if (this.initialized) return 'Reinitialized existing Git repository in /panda/.git/';
    this.initialized = true;
    return 'Initialized empty Git repository in /panda/.git/';
  }

  requireRepo() {
    if (!this.initialized) throw new GitError('fatal: not a git repository (or any of the parent directories): .git\n(hint: run git init first)');
  }

  add(paths: string[]): string {
    this.requireRepo();
    if (!paths.length) throw new GitError('Nothing specified, nothing added.\nhint: Maybe you wanted to say \'git add .\'?');
    const all = paths.some((p) => p === '.' || p === '-A' || p === '--all');
    const targets = all ? new Set([...this.workdir.keys(), ...this.index.keys()]) : new Set(paths);
    for (const p of targets) {
      if (this.workdir.has(p)) {
        const content = this.workdir.get(p)!;
        this.index.set(p, this.write({ type: 'blob', data: content }));
        this.merging?.conflicts.delete(p);
      } else if (this.index.has(p)) {
        this.index.delete(p);
        this.merging?.conflicts.delete(p);
      } else if (!all) {
        throw new GitError(`fatal: pathspec '${p}' did not match any files`);
      }
    }
    return '';
  }

  rm(paths: string[]): string {
    this.requireRepo();
    for (const p of paths) {
      if (!this.index.has(p)) throw new GitError(`fatal: pathspec '${p}' did not match any files`);
      this.index.delete(p);
      this.workdir.delete(p);
    }
    return paths.map((p) => `rm '${p}'`).join('\n');
  }

  commitIndex(message: string | undefined): string {
    this.requireRepo();
    if (this.merging && this.merging.conflicts.size) {
      throw new GitError(`error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.\nU   ${[...this.merging.conflicts].join('\nU   ')}`);
    }
    const parent = this.headSha();
    const st = this.status();
    if (!st.staged.length && !this.merging) {
      if (st.unstaged.length || st.untracked.length) {
        throw new GitError(`nothing added to commit but ${st.unstaged.length ? 'changes' : 'untracked files'} present (use "git add" to track)`);
      }
      throw new GitError(parent ? 'nothing to commit, working tree clean' : 'nothing to commit (create/copy files and use "git add" to track)');
    }
    if (message === undefined) {
      if (!this.merging) throw new GitError('error: there is no text editor in this sandbox - use git commit -m "your message"');
      message = `Merge branch '${this.merging.label}'`;
    }
    const tree = this.writeTree(this.index);
    const now = this.clock();
    const me: Person = { ...this.user, ...now };
    const parents = parent ? [parent] : [];
    if (this.merging) parents.push(this.merging.theirs);
    const sha = this.write({ type: 'commit', tree, parents, author: me, committer: me, message: message.endsWith('\n') ? message : message + '\n' });
    this.moveHead(sha);
    this.merging = null;
    const where = this.head.kind === 'branch' ? this.head.name : 'detached HEAD';
    const root = parent ? '' : ' (root-commit)';
    const n = st.staged.length;
    return `[${where}${root} ${sha.slice(0, 7)}] ${message.split('\n')[0]}\n ${n} file${n === 1 ? '' : 's'} changed`;
  }

  moveHead(sha: string) {
    if (this.head.kind === 'branch') this.branches.set(this.head.name, sha);
    else this.head = { kind: 'detached', sha };
  }

  branch(args: string[]): string {
    this.requireRepo();
    const del = args.find((a) => a === '-d' || a === '-D');
    const names = args.filter((a) => !a.startsWith('-'));
    if (del) {
      const name = names[0];
      if (!name) throw new GitError('fatal: branch name required');
      if (!this.branches.has(name)) throw new GitError(`error: branch '${name}' not found`);
      if (this.head.kind === 'branch' && this.head.name === name) throw new GitError(`error: cannot delete branch '${name}' used by HEAD`);
      const tip = this.branches.get(name)!;
      const h = this.headSha();
      if (del === '-d' && (!h || !this.isAncestor(tip, h))) {
        throw new GitError(`error: the branch '${name}' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D ${name}'`);
      }
      this.branches.delete(name);
      return `Deleted branch ${name} (was ${tip.slice(0, 7)}).`;
    }
    if (!names.length) {
      const cur = this.head.kind === 'branch' ? this.head.name : null;
      const lines = [...this.branches.keys()].sort().map((b) => (b === cur ? `* ${b}` : `  ${b}`));
      if (this.head.kind === 'detached') lines.unshift(`* (HEAD detached at ${this.head.sha.slice(0, 7)})`);
      return lines.join('\n');
    }
    const name = names[0];
    this.validBranchName(name);
    if (this.branches.has(name)) throw new GitError(`fatal: a branch named '${name}' already exists`);
    const h = this.headSha();
    if (!h) throw new GitError(`fatal: not a valid object name: '${this.head.kind === 'branch' ? this.head.name : 'HEAD'}'\n(hint: make a first commit - a branch is just a name for a commit)`);
    this.branches.set(name, names[1] ? this.resolve(names[1]) : h);
    return '';
  }

  validBranchName(name: string) {
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('-') || name.includes('..') || name.endsWith('/')) {
      throw new GitError(`fatal: '${name}' is not a valid branch name`);
    }
  }

  /** Replace index and working tree with a commit's tree, refusing to clobber local edits. */
  checkoutTree(target: string | undefined) {
    const from = this.treeOfCommit(this.headSha());
    const to = this.treeOfCommit(target);
    const st = this.status();
    const dirty = new Set([...st.staged.map((s) => s.path), ...st.unstaged.map((s) => s.path)]);
    const clobbered = [...dirty].filter((p) => from.get(p) !== to.get(p));
    if (clobbered.length) {
      throw new GitError(`error: Your local changes to the following files would be overwritten by checkout:\n\t${clobbered.join('\n\t')}\nPlease commit your changes or stash them before you switch branches.\nAborting`);
    }
    for (const p of from.keys()) if (!to.has(p) && !dirty.has(p)) this.workdir.delete(p);
    for (const [p, s] of to) {
      if (from.get(p) === s && dirty.has(p)) continue;
      this.workdir.set(p, (this.get(s) as { data: string }).data);
    }
    const next = new Map(to);
    for (const p of dirty) { if (this.index.has(p)) next.set(p, this.index.get(p)!); }
    this.index = next;
  }

  switchTo(args: string[], legacyCheckout = false): string {
    this.requireRepo();
    if (this.merging) throw new GitError('error: you need to resolve your current merge first (git merge --abort to give up)');
    const create = args.find((a) => a === '-c' || a === '-b' || a === '-C');
    const name = args.filter((a) => !a.startsWith('-'))[0];
    if (!name) throw new GitError(`fatal: missing branch or commit argument`);
    if (create) {
      this.branch([name]);
      this.head = { kind: 'branch', name };
      return `Switched to a new branch '${name}'`;
    }
    if (this.branches.has(name)) {
      if (this.head.kind === 'branch' && this.head.name === name) return `Already on '${name}'`;
      this.checkoutTree(this.branches.get(name));
      this.head = { kind: 'branch', name };
      return `Switched to branch '${name}'`;
    }
    let sha: string;
    try { sha = this.resolve(name); } catch {
      throw new GitError(legacyCheckout
        ? `error: pathspec '${name}' did not match any file(s) known to git`
        : `fatal: invalid reference: ${name}\n(hint: git switch -c ${name} creates it)`);
    }
    if (!legacyCheckout && !args.includes('--detach')) {
      throw new GitError(`fatal: a branch is expected, got commit '${name}'\nhint: If you want to detach HEAD at the commit, try again with the --detach option.`);
    }
    this.checkoutTree(sha);
    this.head = { kind: 'detached', sha };
    return `Note: switching to '${name}'.\n\nYou are in 'detached HEAD' state. You can look around and make experimental\ncommits, but they belong to no branch. Switch back with: git switch main\n\nHEAD is now at ${sha.slice(0, 7)} ${this.commit(sha).message.split('\n')[0]}`;
  }

  merge(args: string[]): string {
    this.requireRepo();
    if (args.includes('--abort')) {
      if (!this.merging) throw new GitError('fatal: There is no merge to abort (MERGE_HEAD missing).');
      this.merging = null;
      const head = this.treeOfCommit(this.headSha());
      for (const p of [...this.workdir.keys()]) if (this.index.has(p) && !head.has(p)) this.workdir.delete(p);
      this.index = new Map(head);
      for (const [p, s] of head) this.workdir.set(p, (this.get(s) as { data: string }).data);
      return '';
    }
    if (this.merging) throw new GitError('error: Merging is not possible because you have unmerged files.');
    const label = args.filter((a) => !a.startsWith('-'))[0];
    if (!label) throw new GitError('fatal: No remote for the current branch. (try: git merge <branch>)');
    const theirs = this.resolve(label);
    const ours = this.headSha();
    if (!ours) throw new GitError('fatal: there is nothing to merge into yet - make a commit first');
    const st = this.status();
    if (st.staged.length || st.unstaged.length) {
      throw new GitError(`error: Your local changes would be overwritten by merge.\nPlease commit your changes or stash them before you merge.\nAborting`);
    }
    if (this.isAncestor(theirs, ours)) return 'Already up to date.';
    if (this.isAncestor(ours, theirs) && !args.includes('--no-ff')) {
      this.checkoutTree(theirs);
      this.moveHead(theirs);
      return `Updating ${ours.slice(0, 7)}..${theirs.slice(0, 7)}\nFast-forward`;
    }
    const base = this.mergeBase(ours, theirs);
    const B = this.treeOfCommit(base), O = this.treeOfCommit(ours), T = this.treeOfCommit(theirs);
    const paths = [...new Set([...B.keys(), ...O.keys(), ...T.keys()])].sort();
    const conflicts = new Set<string>();
    const report: string[] = [];
    const text = (s: string | undefined) => (s ? (this.get(s) as { data: string }).data : '');
    for (const p of paths) {
      const b = B.get(p), o = O.get(p), t = T.get(p);
      if (o === t || b === t) continue;
      if (b === o) {
        if (t === undefined) { this.index.delete(p); this.workdir.delete(p); }
        else { this.index.set(p, t); this.workdir.set(p, text(t)); }
        continue;
      }
      if (o === undefined || t === undefined) {
        conflicts.add(p);
        report.push(`CONFLICT (modify/delete): ${p} deleted in ${o === undefined ? 'HEAD' : label} and modified in ${o === undefined ? label : 'HEAD'}.`);
        if (t !== undefined) this.workdir.set(p, text(t));
        continue;
      }
      report.push(`Auto-merging ${p}`);
      const m = merge3(text(b), text(o), text(t), 'HEAD', label);
      this.workdir.set(p, m.text);
      if (m.conflict) {
        conflicts.add(p);
        report.push(`CONFLICT (${b === undefined ? 'add/add' : 'content'}): Merge conflict in ${p}`);
      } else this.index.set(p, this.write({ type: 'blob', data: m.text }));
    }
    this.merging = { theirs, label, conflicts };
    if (conflicts.size) {
      report.push('Automatic merge failed; fix conflicts and then commit the result.');
      return report.join('\n');
    }
    const out = this.commitIndex(undefined);
    return [...report, `Merge made by the 'ort' strategy.`, out.split('\n').slice(1).join('\n')].join('\n');
  }

  log(oneline: boolean): string {
    this.requireRepo();
    const h = this.headSha();
    if (!h) {
      throw new GitError(`fatal: your current branch '${this.head.kind === 'branch' ? this.head.name : 'HEAD'}' does not have any commits yet`);
    }
    const reach = this.ancestors(h);
    const commits = this.allCommits().filter((c) => reach.has(c));
    return commits.map((c) => {
      const o = this.commit(c);
      const deco = this.decorations(c);
      const subject = o.message.split('\n')[0];
      if (oneline) return `${c.slice(0, 7)}${deco ? ` (${deco})` : ''} ${subject}`;
      const merge = o.parents.length > 1 ? `\nMerge: ${o.parents.map((p) => p.slice(0, 7)).join(' ')}` : '';
      const date = new Date(o.author.time * 1000).toUTCString();
      return `commit ${c}${deco ? ` (${deco})` : ''}${merge}\nAuthor: ${o.author.name} <${o.author.email}>\nDate:   ${date}\n\n    ${subject}\n`;
    }).join('\n');
  }

  decorations(sha: string): string {
    const out: string[] = [];
    const cur = this.head.kind === 'branch' ? this.head.name : null;
    if (this.head.kind === 'detached' && this.head.sha === sha) out.push('HEAD');
    for (const [b, s] of [...this.branches].sort()) {
      if (s !== sha) continue;
      out.push(b === cur ? `HEAD -> ${b}` : b);
    }
    out.sort((a, b) => (a.startsWith('HEAD') ? -1 : b.startsWith('HEAD') ? 1 : 0));
    return out.join(', ');
  }

  diff(staged: boolean): string {
    this.requireRepo();
    const head = this.treeOfCommit(this.headSha());
    const from: Map<string, string> = staged ? head : this.index;
    const toText = (p: string) => staged
      ? (this.index.has(p) ? (this.get(this.index.get(p)!) as { data: string }).data : undefined)
      : this.workdir.get(p);
    const paths = [...new Set([...from.keys(), ...(staged ? this.index.keys() : [...this.index.keys()])])].sort();
    const chunks: string[] = [];
    for (const p of paths) {
      const a = from.has(p) ? (this.get(from.get(p)!) as { data: string }).data : undefined;
      const b = toText(p);
      if (a === b) continue;
      const ops = diffLines(splitLines(a ?? ''), splitLines(b ?? ''));
      chunks.push(`diff --git a/${p} b/${p}\n--- ${a === undefined ? '/dev/null' : 'a/' + p}\n+++ ${b === undefined ? '/dev/null' : 'b/' + p}\n` +
        ops.map((d) => d.op + d.line).join('\n'));
    }
    return chunks.join('\n');
  }

  restore(args: string[]): string {
    this.requireRepo();
    const staged = args.includes('--staged');
    const paths = args.filter((a) => !a.startsWith('-'));
    const head = this.treeOfCommit(this.headSha());
    for (const p of paths) {
      if (staged) {
        if (head.has(p)) this.index.set(p, head.get(p)!); else this.index.delete(p);
      } else {
        const s = this.index.get(p);
        if (!s) throw new GitError(`error: pathspec '${p}' did not match any file(s) known to git`);
        this.workdir.set(p, (this.get(s) as { data: string }).data);
      }
    }
    return '';
  }

  /** `git show <rev>:<path>` prints that file as it was; `git show <rev>` prints
   *  the commit and what it changed. The first is how a deleted secret is read
   *  straight back out of history. */
  show(args: string[]): string {
    this.requireRepo();
    const target = args.filter((a) => !a.startsWith('-'))[0] ?? 'HEAD';
    const colon = target.indexOf(':');
    if (colon >= 0) {
      const rev = target.slice(0, colon), path = target.slice(colon + 1);
      if (!rev) throw new GitError('git show :<path> (the staged copy) is not in this sandbox - name a commit, like HEAD~1:<path>');
      const blob = this.treeOfCommit(this.resolve(rev)).get(path);
      if (!blob) {
        throw new GitError(this.workdir.has(path)
          ? `fatal: path '${path}' exists on disk, but not in '${rev}'`
          : `fatal: path '${path}' does not exist in '${rev}'`);
      }
      return (this.get(blob) as { data: string }).data.replace(/\n$/, '');
    }
    const sha = this.resolve(target);
    const o = this.commit(sha);
    const deco = this.decorations(sha);
    const head = `commit ${sha}${deco ? ` (${deco})` : ''}\nAuthor: ${o.author.name} <${o.author.email}>\nDate:   ${new Date(o.author.time * 1000).toUTCString()}\n\n    ${o.message.split('\n')[0]}\n`;
    const before = this.treeOfCommit(o.parents[0]), after = this.flatten(o.tree);
    const chunks: string[] = [];
    for (const p of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      if (before.get(p) === after.get(p)) continue;
      const a = before.has(p) ? (this.get(before.get(p)!) as { data: string }).data : undefined;
      const b = after.has(p) ? (this.get(after.get(p)!) as { data: string }).data : undefined;
      const ops = diffLines(splitLines(a ?? ''), splitLines(b ?? ''));
      chunks.push(`diff --git a/${p} b/${p}\n--- ${a === undefined ? '/dev/null' : 'a/' + p}\n+++ ${b === undefined ? '/dev/null' : 'b/' + p}\n` +
        ops.map((d) => d.op + d.line).join('\n'));
    }
    return [head, ...chunks].join('\n');
  }

  catFile(args: string[]): string {
    this.requireRepo();
    const flag = args.find((a) => a === '-p' || a === '-t' || a === '-s');
    const rev = args.filter((a) => !a.startsWith('-'))[0];
    if (!flag || !rev) throw new GitError('usage: git cat-file (-t | -s | -p) <object>');
    const sha = this.resolve(rev);
    const o = this.get(sha);
    if (flag === '-t') return o.type;
    if (flag === '-s') { const raw = serialize(o); return String(raw.length - raw.indexOf(0) - 1); }
    if (o.type === 'blob') return o.data.replace(/\n$/, '');
    if (o.type === 'tree') return o.entries.map((e) => `${e.mode.padStart(6, '0')} ${e.mode === '40000' ? 'tree' : 'blob'} ${e.sha}\t${e.name}`).join('\n');
    return commitText(o).replace(/\n$/, '');
  }
}
