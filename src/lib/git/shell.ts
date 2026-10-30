// The command line in front of the repo. It understands just enough shell
// (quotes, > and >>) to make files, and passes `git ...` to the repo. Anything
// it does not support says so by name - an unknown command that printed nothing
// would read as "it worked".

import { Repo, GitError } from './repo.ts';

export type Line = { text: string; kind: 'out' | 'err' | 'hint' };

export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '', quote: '"' | "'" | null = null, had = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && input[i + 1] === '"') { cur += '"'; i++; }
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; had = true; }
    else if (ch === ' ' || ch === '\t') { if (cur || had) out.push(cur); cur = ''; had = false; }
    else if (ch === '>') {
      if (cur || had) out.push(cur);
      cur = ''; had = false;
      if (input[i + 1] === '>') { out.push('>>'); i++; } else out.push('>');
    } else cur += ch;
  }
  if (quote) throw new GitError(`shell: unterminated ${quote} quote`);
  if (cur || had) out.push(cur);
  return out;
}

const SUPPORTED = 'init status add rm commit log branch switch checkout merge diff restore show cat-file hash-object';
const NOT_HERE = new Set(['rebase', 'reset', 'stash', 'cherry-pick', 'push', 'pull', 'fetch', 'clone', 'remote', 'tag', 'revert', 'bisect', 'reflog']);

export const HELP = `Shell:  ls   cat <file>   echo "text" > <file>   echo "more" >> <file>
        touch <file>   rm <file>   clear   help
Git:    ${SUPPORTED}
Try:    git init, then echo "hello" > hello.txt, then git status`;

export function run(repo: Repo, input: string): Line[] {
  const line = input.trim();
  if (!line) return [];
  try {
    return toLines(exec(repo, tokenize(line)));
  } catch (e) {
    if (e instanceof GitError) return toLines(e.message, 'err');
    throw e;
  }
}

function toLines(text: string, kind: Line['kind'] = 'out'): Line[] {
  if (!text) return [];
  return text.split('\n').map((t) => ({ text: t, kind: kind === 'err' ? 'err' : t.startsWith('hint:') ? 'hint' : kind }));
}

function exec(repo: Repo, argv: string[]): string {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'help': return HELP;
    case 'ls': {
      const files = [...repo.workdir.keys()].sort();
      return files.length ? files.join('  ') : '';
    }
    case 'cat': {
      if (!args.length) throw new GitError('cat: missing file operand');
      return args.map((p) => {
        if (!repo.workdir.has(p)) throw new GitError(`cat: ${p}: No such file or directory`);
        return repo.workdir.get(p)!.replace(/\n$/, '');
      }).join('\n');
    }
    case 'echo': {
      const op = args.findIndex((a) => a === '>' || a === '>>');
      if (op < 0) return args.join(' ');
      const file = args[op + 1];
      if (!file) throw new GitError('shell: syntax error near unexpected token `newline\'');
      checkPath(file);
      const text = args.slice(0, op).join(' ') + '\n';
      const prev = args[op] === '>>' ? repo.workdir.get(file) ?? '' : '';
      repo.workdir.set(file, prev + text);
      return '';
    }
    case 'touch': {
      for (const p of args) { checkPath(p); if (!repo.workdir.has(p)) repo.workdir.set(p, ''); }
      return '';
    }
    case 'rm': {
      for (const p of args) {
        if (!repo.workdir.has(p)) throw new GitError(`rm: cannot remove '${p}': No such file or directory`);
        repo.workdir.delete(p);
      }
      return '';
    }
    case 'pwd': return '/panda';
    case 'git': return git(repo, args);
    default:
      throw new GitError(`${cmd}: command not found (type help to see what this sandbox knows)`);
  }
}

function checkPath(p: string) {
  if (p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '' || s === '.git')) {
    throw new GitError(`shell: '${p}' - keep files inside the project (no absolute paths, .. or .git)`);
  }
}

function git(repo: Repo, args: string[]): string {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined: case 'help': case '--help': return `usage: git <command>\nThis sandbox knows: ${SUPPORTED}`;
    case 'init': return repo.init();
    case 'status': return status(repo);
    case 'add': return repo.add(rest);
    case 'rm': return repo.rm(rest.filter((a) => !a.startsWith('-')));
    case 'commit': {
      const i = rest.findIndex((a) => a === '-m' || a === '-am');
      if (rest.includes('-a') || rest[i] === '-am') repo.add(['.']);
      if (i >= 0 && rest[i + 1] === undefined) throw new GitError("error: switch `m' requires a value");
      return repo.commitIndex(i >= 0 ? rest[i + 1] : undefined);
    }
    case 'log': return repo.log(rest.includes('--oneline'));
    case 'branch': return repo.branch(rest);
    case 'switch': return repo.switchTo(rest);
    case 'checkout': return repo.switchTo(rest, true);
    case 'merge': return repo.merge(rest);
    case 'diff': return repo.diff(rest.includes('--staged') || rest.includes('--cached'));
    case 'restore': return repo.restore(rest);
    case 'show': return repo.show(rest);
    case 'cat-file': return repo.catFile(rest);
    case 'hash-object': {
      const p = rest.filter((a) => !a.startsWith('-'))[0];
      if (!p || !repo.workdir.has(p)) throw new GitError(`fatal: could not open '${p ?? ''}' for reading: No such file or directory`);
      const content = repo.workdir.get(p)!;
      if (rest.includes('-w')) repo.write({ type: 'blob', data: content });
      return repo.blobSha(content);
    }
    default:
      if (NOT_HERE.has(sub)) throw new GitError(`git ${sub}: real git has this, this sandbox does not yet.\nhint: the "Do it for real" section at the end of each lesson shows how to try it on your machine.`);
      throw new GitError(`git: '${sub}' is not a git command. See 'git help'.`);
  }
}

function status(repo: Repo): string {
  repo.requireRepo();
  const st = repo.status();
  const out: string[] = [];
  if (repo.head.kind === 'branch') out.push(`On branch ${repo.head.name}`);
  else out.push(`HEAD detached at ${repo.head.sha.slice(0, 7)}`);
  if (!repo.headSha()) out.push('', 'No commits yet');
  const conflicts = repo.merging?.conflicts ?? new Set<string>();
  if (repo.merging) {
    out.push(conflicts.size
      ? 'You have unmerged paths.\n  (fix conflicts and run "git commit")\n  (use "git merge --abort" to abort the merge)'
      : 'All conflicts fixed but you are still merging.\n  (use "git commit" to conclude merge)');
  }
  const staged = st.staged.filter((s) => !conflicts.has(s.path));
  if (staged.length) {
    out.push('', 'Changes to be committed:', '  (use "git restore --staged <file>..." to unstage)');
    for (const s of staged) out.push(`\t${(s.kind + ':').padEnd(12)}${s.path}`);
  }
  if (conflicts.size) {
    out.push('', 'Unmerged paths:', '  (use "git add <file>..." to mark resolution)');
    for (const p of [...conflicts].sort()) out.push(`\tboth modified:   ${p}`);
  }
  const unstaged = st.unstaged.filter((s) => !conflicts.has(s.path));
  if (unstaged.length) {
    out.push('', 'Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)');
    for (const s of unstaged) out.push(`\t${(s.kind + ':').padEnd(12)}${s.path}`);
  }
  if (st.untracked.length) {
    out.push('', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
    for (const p of st.untracked) out.push(`\t${p}`);
  }
  if (!staged.length && !unstaged.length && !st.untracked.length && !conflicts.size) {
    out.push(repo.headSha() ? '\nnothing to commit, working tree clean' : '\nnothing to commit (create/copy files and use "git add" to track)');
  }
  return out.join('\n');
}
