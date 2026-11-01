// A small bash for the Linux track: an in-memory filesystem, a process table
// and the text tools, joined by real pipes. Typed text is parsed into words and
// dispatched to the commands below; nothing is ever evaluated. Output formats
// that learners will meet again (uniq -c, wc, job messages, exit codes) are
// pinned against the real tools by tests/shell-parity.test.ts.

import { Fs, FsError, USERS, canAccess, modeString, R, W, X, type Node, type File, type Dir, type User } from './fs.ts';

export type Line = { text: string; kind: 'out' | 'err' | 'hint' | 'dim' };
type Part = { s: string; q: 'none' | 'single' | 'double' };
type Word = Part[];
type Redirect = { fd: 0 | 1 | 2; append: boolean; target: Word };
type Command = { words: Word[]; redirects: Redirect[] };
type Pipeline = { cmds: Command[]; background: boolean };
type ListItem = { pipeline: Pipeline; op: ';' | '&&' | '||' | '&' | null };

export type Proc = {
  pid: number; name: string; cmd: string; owner: string;
  // How it reacts to TERM/INT/HUP. KILL is never up to the process.
  onTerm: 'exit' | 'ignore' | 'graceful';
  alive: boolean; status?: number; job?: number;
  child?: boolean;      // started from this shell, so `wait` may collect it
  cleanup?: string[];   // printed when it shuts down gracefully
  unsaved?: string;     // what is lost if it dies without cleaning up
  killedBy?: string;
};
export type Signal = { pid: number; name: string; sig: string; outcome: 'ignored' | 'graceful' | 'died' };

export const SIGNALS: Record<string, number> = { HUP: 1, INT: 2, KILL: 9, TERM: 15 };
const SIG_TEXT: Record<number, string> = { 1: 'Hangup', 2: 'Interrupt', 9: 'Killed', 15: 'Terminated' };

class ShellError extends Error {
  code: number;
  constructor(msg: string, code = 1) { super(msg); this.code = code; }
}
// `exit` inside a script, however deep in a list: `cd x || exit 1` has to stop the
// script there. It passes through everything up to runScript, which is its catcher.
class ScriptExit { code: number; constructor(code: number) { this.code = code; } }

// A script that runs itself would otherwise overflow the JS stack. Real bash keeps
// going until the machine runs out of processes, which nothing here can show.
const MAX_SCRIPT_DEPTH = 50;
// EX_SOFTWARE from sysexits.h, "internal software error". Anything but 0 would do:
// what matters is that `echo $?` can't say a crash worked.
const SANDBOX_BUG_STATUS = 70;

// Things real Linux has that this sandbox deliberately does not. Saying so by
// name beats "command not found", which would read as a typo.
const REFUSED: Record<string, string> = {
  sudo: 'sudo: there is no root password in this sandbox - and finding the fix that does not need root is the lesson',
  su: 'su: there is no root password in this sandbox',
  vi: 'vi: no editor here - use echo "..." > file, or >> to add a line',
  vim: 'vim: no editor here - use echo "..." > file, or >> to add a line',
  nano: 'nano: no editor here - use echo "..." > file, or >> to add a line',
  emacs: 'emacs: no editor here - use echo "..." > file, or >> to add a line',
  less: 'less: no pager here - use cat, head or tail',
  more: 'more: no pager here - use cat, head or tail',
  man: 'man: no manual pages in the sandbox - the real ones are at man7.org',
  top: 'top: not in this sandbox - use ps -e',
  htop: 'htop: not in this sandbox - use ps -e',
  apt: 'apt: nothing can be installed in the sandbox',
  'apt-get': 'apt-get: nothing can be installed in the sandbox',
  ssh: 'ssh: the sandbox has no network',
  curl: 'curl: the sandbox has no network',
  wget: 'wget: the sandbox has no network',
  python: 'python: not in this sandbox',
  python3: 'python3: not in this sandbox',
  // Real bash has every one of these. The script lesson teaches them on a real
  // machine; "command not found" here would say they don't exist.
  set: 'set: real bash has it (set -e, set -o pipefail); this sandbox does not. Try it on a real machine',
  if: 'if: real bash has it; this sandbox runs one line at a time and has no if. && and || work here',
  then: 'then: real bash has if/then; this sandbox does not',
  else: 'else: real bash has if/else; this sandbox does not',
  fi: 'fi: real bash has if/fi; this sandbox does not',
  for: 'for: real bash has it; this sandbox has no loops. Try it on a real machine',
  while: 'while: real bash has it; this sandbox has no loops. Try it on a real machine',
  do: 'do: real bash has for/do; this sandbox does not',
  done: 'done: real bash has for/done; this sandbox does not',
  function: 'function: real bash has it; this sandbox has no shell functions',
  export: 'export: real bash has it; this sandbox has no variables you can set',
  read: 'read: real bash has it; this sandbox has no variables you can set',
  source: 'source: real bash has it; this sandbox runs scripts with bash FILE or ./FILE',
  '[': '[: real bash has it, for use with if; this sandbox has no if. && and || work here',
  test: 'test: real bash has it, for use with if; this sandbox has no if. && and || work here',
  '[[': '[[: real bash has it, for use with if; this sandbox has no if. && and || work here',
  '!': '!: real bash has it, and it flips a status; this sandbox does not. && and || work here',
  '{': '{: real bash has it, to group commands; this sandbox does not',
  case: 'case: real bash has it; this sandbox does not',
  until: 'until: real bash has it; this sandbox has no loops. Try it on a real machine',
  local: 'local: real bash has it; this sandbox has no shell functions',
  return: 'return: real bash has it; this sandbox has no shell functions',
  shift: 'shift: real bash has it; this sandbox does not',
  unset: 'unset: real bash has it; this sandbox has no variables you can set',
  awk: 'awk: not in this sandbox - cut, grep and sort cover most of what you need here',
  sed: 'sed: not in this sandbox - cut, grep and sort cover most of what you need here',
  tr: 'tr: not in this sandbox - cut, grep and sort cover most of what you need here',
  find: 'find: not in this sandbox - use ls',
  xargs: 'xargs: not in this sandbox',
  which: 'which: not in this sandbox - type help for what it knows',
  env: 'env: not in this sandbox - it has only $USER, $HOME and $PWD',
};

const HELP = `This sandbox knows:
  files      pwd cd ls [-l -a] cat echo printf mkdir [-p] touch rm [-r -f] cp mv tee
  people     whoami id hostname chmod
  processes  ps [-e] kill [-TERM -KILL -INT -l] sleep N [&] jobs wait
  text       grep [-i -v -c -n -E] wc [-l -w -c] sort [-r -n -u] uniq [-c -d] head tail cut
  shell      | > >> < 2> && || ; &   $? $! $$ $USER $HOME   bash FILE  ./FILE  history true false
  scripts    # comments, exit N, and $1 to $9, $# for the words after the script's name
Time stands still here: sleep returns at once, and background jobs run until stopped.`;

const BASE_TIME = Date.UTC(2026, 9, 30, 9, 0); // ls -l dates: Oct 30 09:00
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const bytes = (s: string) => new TextEncoder().encode(s).length;
const lines = (s: string) => { const l = s.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
const joinLines = (l: string[]) => (l.length ? l.join('\n') + '\n' : '');
// sort and ls compare bytes, as in the C locale. Real tools follow your locale,
// which can order "B" and "a" the other way round.
const cmpC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// ${1} needs its digits here: without them `echo ${1}x` printed itself, silently.
const VAR = /\$(\?|!|\$|#|[0-9]|[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z0-9_?!$]+\})/g;
const validSleep = (args: string[]) => args.length > 0 && args.every((a) => /^\d+(\.\d+)?[smhd]?$/.test(a));

export class Shell {
  fs = new Fs();
  user: User = USERS.panda;
  home = '/home/panda';
  cwd = '/home/panda';
  oldpwd = '/home/panda';
  status = 0;
  lastBg = 0;
  readonly pid = 4242;
  procs = new Map<number, Proc>();
  nextPid = 4250;
  nextJob = 1;
  history: string[] = [];
  signals: Signal[] = [];
  /** What `echo $?`-style lines printed: missions check the learner read a status. */
  echoedStatus: number[] = [];
  /** Everything printed to the terminal by the last command line. */
  lastOut = '';
  /** The last line's standard output exactly as written, trailing newline or not. */
  rawOut = '';
  /** Standard output of every command line, in order: missions check answers here. */
  outputs: string[] = [];
  /** Scripts run, by absolute path, with their exit status. */
  scriptRuns: { path: string; code: number }[] = [];
  private notes: Line[] = [];
  /** The arguments of the running script, or null at the prompt. */
  private args: string[] | null = null;
  /** What $0 says inside a script: its name, as it was typed. */
  private scriptName: string | null = null;
  private scriptDepth = 0;

  // ---- running a line ---------------------------------------------------

  run(line: string): Line[] {
    if (line.trim()) this.history.push(line);
    this.notes = [];
    this.rawOut = '';
    const out: Line[] = [];
    let list: ListItem[];
    try { list = parse(tokenize(line)); }
    catch (e) { this.status = 2; return [{ text: `bash: ${(e as Error).message}`, kind: 'err' }]; }
    for (let i = 0; i < list.length; i++) {
      // Each && or || looks only at the current status: in `false && a || b`,
      // a is skipped, the status stays 1, so b runs.
      const prevOp = i > 0 ? list[i - 1].op : null;
      if ((prevOp === '&&' && this.status !== 0) || (prevOp === '||' && this.status === 0)) continue;
      try {
        out.push(...this.runPipeline(list[i].pipeline, list[i].op === '&'));
      } catch (e) {
        // ScriptExit is how `exit` travels, and inside a script the outermost run() is
        // the one that reports. `wc -l acces.log` used to throw a TypeError here: the
        // terminal printed nothing and `echo $?` said 0, which is the failure the
        // shell-scripts lesson warns about, committed by the lesson's own terminal.
        if (e instanceof ScriptExit || this.scriptDepth > 0) throw e;
        console.error('sandbox shell bug on:', line, e);
        out.push({ text: `[sandbox] That's a bug in the sandbox, not your command (${e instanceof Error ? e.message : String(e)}). Real bash would have answered. Start over gives you a fresh machine.`, kind: 'err' });
        this.status = SANDBOX_BUG_STATUS;
        break;
      }
      out.push(...this.notes.splice(0));
    }
    this.lastOut = out.filter((l) => l.kind === 'out').map((l) => l.text).join('\n');
    this.outputs.push(this.lastOut);
    return out;
  }

  private runPipeline(p: Pipeline, background: boolean): Line[] {
    const out: Line[] = [];
    const err = (text: string) => out.push({ text, kind: 'err' });
    if (background) return this.background(p, out);
    let stdin: string | null = null;
    let code = 0;
    for (let i = 0; i < p.cmds.length; i++) {
      const c = p.cmds[i];
      const last = i === p.cmds.length - 1;
      try {
        const argv = c.words.flatMap((w) => this.expand(w));
        const redir = c.redirects.map((r) => {
          const targets = this.expand(r.target);
          // `> $1` with an empty or two-word $1: bash refuses and runs nothing.
          if (targets.length !== 1) throw new ShellError(`bash: ${r.target.map((t) => t.s).join('')}: ambiguous redirect`);
          return { ...r, path: targets[0] };
        });
        const inR = redir.filter((r) => r.fd === 0).pop();
        if (inR) stdin = this.readFile(inR.path, 'bash');
        const outR = redir.filter((r) => r.fd === 1).pop();
        const errR = redir.filter((r) => r.fd === 2).pop();
        // Redirections are opened - and > truncates - before the command runs,
        // exactly as in bash: a refused one means the command never runs, and
        // `cat f > f` reads a file that is already empty.
        if (outR) this.writeFile(outR.path, '', outR.append, 'bash');
        if (errR) this.writeFile(errR.path, '', errR.append, 'bash');
        const errs: string[] = [];
        const tty = last && !outR;
        // Typed by hand: scripts run lines through run() again, and that
        // recursion defeats TypeScript's inference.
        const res: { out: string; code: number } = argv.length ? this.exec(argv, { stdin, tty, err: (t) => errs.push(t) }) : { out: '', code: 0 };
        code = res.code;
        if (errR) this.writeFile(errR.path, joinLines(errs), true, 'bash');
        else errs.forEach(err);
        if (outR) { this.writeFile(outR.path, res.out, true, 'bash'); stdin = ''; }
        else stdin = res.out;
      } catch (e) {
        // Each part of a real pipeline is a process of its own, so `exit 3 | cat` ends
        // that part and not the script.
        if (e instanceof ScriptExit && p.cmds.length > 1) { code = e.code; stdin = ''; continue; }
        if (!(e instanceof ShellError)) throw e;
        err(e.message); code = e.code; stdin = '';
      }
    }
    for (const l of lines(stdin ?? '')) out.push({ text: l, kind: 'out' });
    this.rawOut += stdin ?? '';
    this.status = code;
    return out;
  }

  private background(p: Pipeline, out: Line[]): Line[] {
    let argv: string[];
    try { argv = p.cmds[0].words.flatMap((w) => this.expand(w)); }
    catch (e) {
      if (!(e instanceof ShellError)) throw e;
      out.push({ text: e.message, kind: 'err' });
      this.status = e.code;
      return out;
    }
    const job = this.nextJob++, pid = this.nextPid++;
    const cmd = argv.join(' ');
    out.push({ text: `[${job}] ${pid}`, kind: 'out' });
    this.lastBg = pid;
    this.status = 0;
    // A sleep it can't parse fails at once on a real machine too: leaving it "running"
    // forever would report a job that never started.
    if (p.cmds.length === 1 && argv[0] === 'sleep' && validSleep(argv.slice(1))) {
      this.procs.set(pid, { pid, name: 'sleep', cmd, owner: this.user.name, onTerm: 'exit', alive: true, job, child: true });
    } else {
      // Anything else finishes at once: time does not pass in the sandbox.
      const res = this.runPipeline(p, false);
      out.push(...res);
      this.procs.set(pid, { pid, name: argv[0] ?? '', cmd, owner: this.user.name, onTerm: 'exit', alive: false, status: this.status, job, child: true });
      this.notes.push({ text: jobLine(job, this.status === 0 ? 'Done' : `Exit ${this.status}`, cmd), kind: 'out' });
      this.procs.get(pid)!.job = undefined;
    }
    return out;
  }

  // ---- words ------------------------------------------------------------

  private vars(name: string): string {
    switch (name) {
      case '?': return String(this.status);
      case '!': return this.lastBg ? String(this.lastBg) : '';
      case '$': return String(this.pid);
      case 'USER': return this.user.name;
      case 'HOME': return this.home;
      case 'PWD': return this.cwd;
      case '#': return String((this.args ?? []).length);
      case '0': return this.scriptName ?? 'bash';
      default:
        if (/^[1-9][0-9]*$/.test(name)) return this.args?.[Number(name) - 1] ?? '';
        return '';
    }
  }

  /**
   * One word as typed becomes zero or more words, as in bash: an unquoted $1 holding
   * "a b" is two words, and an unquoted empty $1 is none at all. Treating it as one
   * word made `grep x $1` find a file called "a b" here while real bash looks for two
   * files, so the quotes the lesson teaches made no difference in the lesson's own lab.
   */
  private expand(w: Word): string[] {
    const fields: { s: string; glob: boolean }[] = [];
    let cur = '', started = false, globbable = false;
    const finish = () => { if (started) fields.push({ s: cur, glob: globbable }); cur = ''; started = false; globbable = false; };
    const tilde = p0isTilde(w);
    w.forEach((p, n) => {
      // These would otherwise print themselves literally, which reads as if the
      // shell ran them and got that answer. Refused by name, like the rest.
      if (p.q !== 'single' && /\$\(|`|\$\{[^}]*[^A-Za-z0-9_?!$}]|\$[@*]/.test(p.s)) throw new ShellError(`bash: ${p.s}: real bash can do this; this sandbox has only $1 to $9, $#, $?, $!, $$, $USER, $HOME and $PWD`, 1);
      const nameOf = (raw: string) => raw.replace(/^\{|\}$/g, '');
      if (p.q === 'single') { cur += p.s; started = true; return; }
      if (p.q === 'double') { cur += p.s.replace(VAR, (_, v: string) => this.vars(nameOf(v))); started = true; return; }
      const text = n === 0 && tilde ? this.home + p.s.slice(1) : p.s;
      let at = 0;
      const literal = (t: string) => { if (t) { cur += t; started = true; if (/[*?]/.test(t)) globbable = true; } };
      for (const m of text.matchAll(VAR)) {
        literal(text.slice(at, m.index));
        at = m.index + m[0].length;
        this.vars(nameOf(m[1])).split(/[ \t\n]+/).forEach((piece, i) => {
          if (i > 0) finish();
          if (piece) { cur += piece; started = true; if (/[*?]/.test(piece)) globbable = true; }
        });
      }
      literal(text.slice(at));
    });
    finish();
    return fields.flatMap((f) => {
      if (!f.glob) return [f.s];
      const matches = this.glob(f.s);
      return matches.length ? matches : [f.s];
    });
  }

  private glob(pattern: string): string[] {
    const slash = pattern.lastIndexOf('/');
    const dirPart = slash >= 0 ? pattern.slice(0, slash + 1) : '';
    const base = pattern.slice(slash + 1);
    if (/[*?]/.test(dirPart)) return [];
    let dir: Node | undefined;
    try { dir = this.fs.lookup(this.abs(dirPart || '.'), this.user); } catch { return []; }
    if (!dir || dir.type !== 'dir' || !canAccess(dir, this.user, R)) return [];
    const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return [...dir.children.keys()].filter((n) => !n.startsWith('.') && re.test(n)).sort(cmpC).map((n) => dirPart + n);
  }

  // ---- filesystem helpers -----------------------------------------------

  abs(path: string) { return Fs.normalize(this.cwd, path, this.home); }

  node(path: string, who: string): Node {
    // An empty name is no file at all, where joined to the current folder it read as
    // that folder. `grep 500 "$1"` with no argument is how a script reaches this.
    if (path === '') throw new ShellError(`${who}: : No such file or directory`);
    try {
      const n = this.fs.lookup(this.abs(path), this.user);
      if (!n) throw new ShellError(`${who}: ${path}: No such file or directory`);
      return n;
    } catch (e) {
      if (e instanceof FsError) throw new ShellError(`${who}: ${path}: ${e.message}`);
      throw e;
    }
  }

  readFile(path: string, who: string): string {
    const n = this.node(path, who);
    if (n.type === 'dir') throw new ShellError(`${who}: ${path}: Is a directory`);
    if (!canAccess(n, this.user, R)) throw new ShellError(`${who}: ${path}: Permission denied`);
    return n.device === 'null' ? '' : n.content;
  }

  writeFile(path: string, text: string, append: boolean, who: string): File {
    if (path === '') throw new ShellError(`${who}: ${who === 'bash' ? '' : "''"}: No such file or directory`);
    const abs = this.abs(path);
    let existing: Node | undefined;
    try { existing = this.fs.lookup(abs, this.user); } catch (e) { throw new ShellError(`${who}: ${path}: ${(e as Error).message}`); }
    if (existing) {
      if (existing.type === 'dir') throw new ShellError(`${who}: ${path}: Is a directory`);
      if (!canAccess(existing, this.user, W)) throw new ShellError(`${who}: ${path}: Permission denied`);
      if (existing.device !== 'null') { existing.content = append ? existing.content + text : text; existing.mtime++; }
      return existing;
    }
    let parent: { dir: Dir; name: string };
    try { parent = this.fs.parentOf(abs, this.user); } catch (e) { throw new ShellError(`${who}: ${path}: ${(e as Error).message}`); }
    if (!canAccess(parent.dir, this.user, W)) throw new ShellError(`${who}: ${path}: Permission denied`);
    const f: File = { type: 'file', content: text, mode: 0o644, owner: this.user.name, group: this.user.groups[0].name, mtime: 1 };
    parent.dir.children.set(parent.name, f);
    return f;
  }

  // ---- processes --------------------------------------------------------

  spawnDaemon(p: Omit<Proc, 'alive'>) { this.procs.set(p.pid, { ...p, alive: true }); }

  private findTarget(t: string): Proc {
    if (t.startsWith('%')) {
      const n = Number(t.slice(1));
      const p = [...this.procs.values()].find((x) => x.job === n);
      if (!p) throw new ShellError(`bash: kill: ${t}: no such job`);
      return p;
    }
    if (!/^\d+$/.test(t)) throw new ShellError(`bash: kill: ${t}: arguments must be process or job IDs`);
    const p = this.procs.get(Number(t));
    if (!p || !p.alive) throw new ShellError(`bash: kill: (${t}) - No such process`);
    return p;
  }

  deliver(p: Proc, sig: number): void {
    if (!p.alive) return;
    const name = Object.keys(SIGNALS).find((k) => SIGNALS[k] === sig)!;
    if (sig === SIGNALS.KILL) {
      // The kernel ends it. The process never hears about it, so it cannot
      // save anything first - signal(7): KILL cannot be caught or ignored.
      p.alive = false; p.status = 128 + sig; p.killedBy = name;
      this.signals.push({ pid: p.pid, name: p.name, sig: name, outcome: 'died' });
      if (p.unsaved) this.notes.push({ text: `[sandbox] ${p.name} died mid-write: ${p.unsaved}`, kind: 'hint' });
    } else if (p.onTerm === 'ignore') {
      this.signals.push({ pid: p.pid, name: p.name, sig: name, outcome: 'ignored' });
    } else if (p.onTerm === 'graceful') {
      for (const l of p.cleanup ?? []) this.notes.push({ text: `${p.name}[${p.pid}]: ${l}`, kind: 'out' });
      p.alive = false; p.status = 0; p.killedBy = name;
      this.signals.push({ pid: p.pid, name: p.name, sig: name, outcome: 'graceful' });
    } else {
      p.alive = false; p.status = 128 + sig; p.killedBy = name;
      this.signals.push({ pid: p.pid, name: p.name, sig: name, outcome: 'died' });
    }
    if (!p.alive && p.job) {
      const text = p.status === 0 ? 'Done' : SIG_TEXT[p.status! - 128] ?? `Exit ${p.status}`;
      this.notes.push({ text: jobLine(p.job, text, p.cmd), kind: 'out' });
    }
  }

  // ---- commands ---------------------------------------------------------

  private exec(argv: string[], ctx: { stdin: string | null; tty: boolean; err: (t: string) => void }): { out: string; code: number } {
    const [cmd, ...args] = argv;
    // NAME=value would otherwise print "command not found", which real bash doesn't.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) throw new ShellError(`${cmd}: real bash would set a variable here; this sandbox has no variables you can set`, 127);
    // GNU tools accept options anywhere and stop at --. Anything else starting with a
    // dash used to fall through as a file name, so `touch -Q` made a file called -Q and
    // `cat -n f` said there was no file called -n. `bad` is the status the real tool
    // gives a bad option: 1 for most, 2 for grep, sort and ls. A builtin words it its own way.
    const flags = (allowed: string, bad = 1, builtin = false) => {
      const f = new Set<string>(), rest: string[] = [];
      // A real option the sandbox lacks must not read as if real tools lacked it too.
      const knows = allowed ? `this sandbox knows -${allowed.split('').join(' -')}${builtin ? '' : ', and the real one has more'}` : `this sandbox's ${cmd} takes no options, and the real one does`;
      let done = false;
      for (const a of args) {
        if (done || a === '-' || !a.startsWith('-')) { rest.push(a); continue; }
        if (a === '--') { done = true; continue; }
        if (a.startsWith('--')) throw new ShellError(builtin ? `bash: ${cmd}: ${a}: invalid option` : `${cmd}: unrecognized option '${a}' (this sandbox has no long options)`, bad);
        for (const ch of a.slice(1)) {
          if (!allowed.includes(ch)) throw new ShellError(builtin ? `bash: ${cmd}: -${ch}: invalid option (${knows})` : `${cmd}: invalid option -- '${ch}' (${knows})`, bad);
          f.add(ch);
        }
      }
      return { f, rest };
    };
    const needArg = (ch: string) => new ShellError(`${cmd}: option requires an argument -- '${ch}'`);
    const input = (files: string[], who: string, word: (message: string) => string = (m) => m) => {
      if (!files.length) return { text: ctx.stdin ?? '', code: 0, parts: [{ name: '', text: ctx.stdin ?? '' }] };
      let code = 0; const parts: { name: string; text: string }[] = [];
      for (const f of files) {
        if (f === '-') { parts.push({ name: '-', text: ctx.stdin ?? '' }); continue; }
        try { parts.push({ name: f, text: this.readFile(f, who) }); }
        catch (e) {
          if (!(e instanceof ShellError)) throw e;
          ctx.err(word(e.message).replace(/^(cat|uniq|cut): : /, "$1: '': ")); code = who === 'grep' ? 2 : 1;
          // grep -c prints a 0 for a folder it couldn't read, and nothing for a missing file.
          if (who === 'grep' && /Is a directory$/.test(e.message)) parts.push({ name: f, text: '' });
        }
      }
      return { text: parts.map((p) => p.text).join(''), code, parts };
    };
    const ok = (out: string, code = 0) => ({ out, code });

    if (cmd.includes('/')) return this.runScript(cmd, args, true, ctx);
    if (REFUSED[cmd]) throw new ShellError(REFUSED[cmd], 127);

    switch (cmd) {
      case 'help': return ok(HELP + '\n');
      case 'pwd': flags('LP', 2, true); return ok(this.cwd + '\n');
      case 'true': return ok('');
      case 'false': return ok('', 1);
      case 'exit': {
        if (args[0] !== undefined && !/^-?\d+$/.test(args[0])) throw new ShellError(`bash: exit: ${args[0]}: numeric argument required`, 2);
        if (args.length > 1) throw new ShellError('bash: exit: too many arguments', 1);
        if (!this.args) throw new ShellError('exit: this terminal stays open. In a script, exit ends the script', 1);
        throw new ScriptExit(args[0] === undefined ? this.status : ((Number(args[0]) % 256) + 256) % 256);
      }
      case 'whoami': {
        const { rest } = flags('');
        if (rest.length) throw new ShellError(`whoami: extra operand '${rest[0]}'`);
        return ok(this.user.name + '\n');
      }
      case 'hostname': {
        const { rest } = flags('');
        // Real hostname NAME tries to rename the machine. Printing the old name would
        // read as if it had worked.
        if (rest.length) throw new ShellError('hostname: you must be root to change the host name');
        return ok('bamboo\n');
      }
      case 'id': {
        const { rest } = flags('');
        if (rest.length > 1) throw new ShellError(`id: extra operand '${rest[1]}'`);
        const who = rest.length ? USERS[rest[0]] : this.user;
        // Used to print panda's ids for any name at all.
        if (!who) throw new ShellError(`id: '${rest[0]}': no such user`);
        const g = who.groups;
        return ok(`uid=${who.uid}(${who.name}) gid=${g[0].gid}(${g[0].name}) groups=${g.map((x) => `${x.gid}(${x.name})`).join(',')}\n`);
      }
      case 'history': {
        const { rest } = flags('', 2, true);
        if (rest[0] !== undefined && !/^\d+$/.test(rest[0])) throw new ShellError(`bash: history: ${rest[0]}: numeric argument required`);
        const shown = this.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`);
        return ok((rest[0] === undefined ? shown : shown.slice(Math.max(0, shown.length - Number(rest[0])))).join('\n') + '\n');
      }
      case 'cd': {
        // `cd -` is an operand, which flags() already leaves alone.
        const { rest } = flags('LP', 2, true);
        if (rest.length > 1) throw new ShellError('bash: cd: too many arguments');
        const target = rest[0] === '-' ? this.oldpwd : rest[0] ?? this.home;
        const abs = this.abs(target);
        let n: Node | undefined;
        try { n = this.fs.lookup(abs, this.user); } catch (e) { throw new ShellError(`bash: cd: ${target}: ${(e as Error).message}`); }
        if (!n) throw new ShellError(`bash: cd: ${target}: No such file or directory`);
        if (n.type !== 'dir') throw new ShellError(`bash: cd: ${target}: Not a directory`);
        if (!canAccess(n, this.user, X)) throw new ShellError(`bash: cd: ${target}: Permission denied`);
        this.oldpwd = this.cwd; this.cwd = abs;
        return ok(rest[0] === '-' ? abs + '\n' : '');
      }
      case 'ls': return this.ls(args, ctx);
      case 'cat': { const { rest } = flags(''); const r = input(rest, 'cat'); return ok(r.text, r.code); }
      case 'echo': {
        // bash's echo reads leading -n -e -E, in any combination, and prints the rest.
        let at = 0, noNl = false, esc = false;
        while (at < args.length && /^-[neE]+$/.test(args[at])) {
          for (const ch of args[at].slice(1)) { if (ch === 'n') noNl = true; else esc = ch === 'e'; }
          at++;
        }
        let text = args.slice(at).join(' ');
        if (esc) {
          const cut = text.indexOf('\\c');
          if (cut >= 0) { text = text.slice(0, cut); noNl = true; }
          text = text.replace(/\\([\\abefnrtv])/g, (_, c: string) => ECHO_ESCAPES[c]);
        }
        if (this.history.length && /\$\?/.test(this.history[this.history.length - 1]) && /^\d+$/.test(text)) this.echoedStatus.push(Number(text));
        return ok(text + (noNl ? '' : '\n'));
      }
      case 'printf': return this.printf(args, ctx);
      case 'mkdir': {
        const { f, rest } = flags('p');
        if (!rest.length) throw new ShellError('mkdir: missing operand');
        let code = 0;
        for (const path of rest) {
          try { this.mkdir(path, f.has('p')); } catch (e) { if (!(e instanceof ShellError)) throw e; ctx.err(e.message); code = 1; }
        }
        return ok('', code);
      }
      case 'touch': {
        const { rest } = flags('');
        if (!rest.length) throw new ShellError('touch: missing file operand');
        let code = 0;
        for (const path of rest) {
          try {
            if (path === '') { ctx.err("touch: cannot touch '': No such file or directory"); code = 1; continue; }
            const abs = this.abs(path);
            const n = this.fs.lookup(abs, this.user);
            if (n) { if (n.owner !== this.user.name && !canAccess(n, this.user, W)) throw new ShellError(`touch: cannot touch '${path}': Permission denied`); n.mtime++; }
            else this.writeFile(path, '', false, 'touch');
          } catch (e) {
            if (e instanceof FsError) { ctx.err(`touch: cannot touch '${path}': ${e.message}`); code = 1; continue; }
            if (!(e instanceof ShellError)) throw e;
            ctx.err(e.message.replace(/^touch: (.*): (.*)$/, "touch: cannot touch '$1': $2")); code = 1;
          }
        }
        return ok('', code);
      }
      case 'rm': {
        const { f, rest } = flags('rRf');
        if (!rest.length && !f.has('f')) throw new ShellError('rm: missing operand');
        let code = 0;
        for (const path of rest) {
          try { this.rm(path, f.has('r') || f.has('R')); }
          catch (e) {
            if (!(e instanceof ShellError)) throw e;
            if (f.has('f') && /No such file/.test(e.message)) continue;
            ctx.err(e.message); code = 1;
          }
        }
        return ok('', code);
      }
      case 'cp': case 'mv': {
        const { rest } = flags('');
        if (!rest.length) throw new ShellError(`${cmd}: missing file operand`);
        if (rest.length === 1) throw new ShellError(`${cmd}: missing destination file operand after '${rest[0]}'`);
        const dest = rest[rest.length - 1], sources = rest.slice(0, -1);
        let code = 0;
        if (sources.length > 1 && !this.isDir(dest)) throw new ShellError(`${cmd}: target '${dest}': ${this.exists(dest) ? 'Not a directory' : 'No such file or directory'}`);
        for (const src of sources) {
          try { this.copyMove(cmd, src, dest); }
          catch (e) { if (!(e instanceof ShellError)) throw e; ctx.err(e.message); code = 1; }
        }
        return ok('', code);
      }
      case 'tee': {
        const { f, rest } = flags('a');
        let code = 0;
        // A file tee can't write doesn't stop the rest: the others still get written,
        // and the text still comes through.
        for (const path of rest) {
          try { this.writeFile(path, ctx.stdin ?? '', f.has('a'), 'tee'); }
          catch (e) { if (!(e instanceof ShellError)) throw e; ctx.err(e.message); code = 1; }
        }
        return ok(ctx.stdin ?? '', code);
      }
      case 'chmod': return this.chmod(args, ctx);
      case 'ps': return this.ps(args);
      case 'kill': return this.kill(args);
      case 'sleep': {
        const { rest } = flags('');
        if (!rest.length) throw new ShellError('sleep: missing operand');
        for (const a of rest) if (!validSleep([a])) throw new ShellError(`sleep: invalid time interval '${a}'`);
        return ok('');
      }
      case 'jobs': {
        flags('', 2, true);
        const live = [...this.procs.values()].filter((p) => p.job && p.alive);
        return ok(live.map((p, i) => jobLine(p.job!, 'Running', p.cmd + ' &', i === live.length - 1)).join('\n') + (live.length ? '\n' : ''));
      }
      case 'wait': return this.wait(args);
      case 'grep': return this.grep(flags('ivcnE', 2), input);
      case 'wc': {
        const { f, rest } = flags('lwc');
        // Not input(): a directory is an error and still gets a row of zeros. Reading an
        // empty row list here is what threw on `wc -l acces.log`.
        if (!rest.length) return ok(wc([{ name: '', text: ctx.stdin ?? '' }], f, false));
        const parts: WcPart[] = [];
        let code = 0;
        for (const name of rest) {
          if (name === '') { ctx.err('wc: invalid zero-length file name'); code = 1; continue; }
          if (name === '-') { parts.push({ name, text: ctx.stdin ?? '', irregular: true }); continue; }
          try {
            const n = this.node(name, 'wc');
            parts.push({ name, text: this.readFile(name, 'wc'), irregular: n.type === 'file' && !!n.device });
          } catch (e) {
            if (!(e instanceof ShellError)) throw e;
            ctx.err(e.message); code = 1;
            if (/Is a directory$/.test(e.message)) parts.push({ name, text: '', irregular: true });
          }
        }
        return ok(wc(parts, f, true, rest.length), code);
      }
      case 'sort': {
        const { f, rest } = flags('rnu', 2);
        // sort reads everything before it prints anything, so one bad file means no
        // output at all, and status 2, not 1.
        let text = ctx.stdin ?? '';
        if (rest.length) {
          text = '';
          for (const name of rest) {
            if (name === '-') { text += ctx.stdin ?? ''; continue; }
            try { text += this.readFile(name, 'sort'); }
            catch (e) {
              if (!(e instanceof ShellError)) throw e;
              const why = e.message.slice(`sort: ${name}: `.length);
              throw new ShellError(why === 'Is a directory' ? `sort: read failed: ${name}: ${why}` : `sort: cannot read: ${name || "''"}: ${why}`, 2);
            }
          }
        }
        return ok(joinLines(sortLines(lines(text), f)));
      }
      case 'uniq': {
        const { f, rest } = flags('cd');
        if (rest.length > 2) throw new ShellError(`uniq: extra operand '${rest[2]}'`);
        const r = input(rest.slice(0, 1), 'uniq', (m) => m.replace(/^uniq: (.*): Is a directory$/, "uniq: error reading '$1': Is a directory"));
        if (r.code) return ok('', r.code);
        const out = joinLines(uniq(lines(r.text), f.has('c'), f.has('d')));
        // uniq's second name is where the output goes. Reading it as a second input
        // would quietly merge two files.
        if (rest[1] !== undefined) { this.writeFile(rest[1], out, false, 'uniq'); return ok(''); }
        return ok(out);
      }
      case 'head': case 'tail': {
        let n = 10, from = false, butLast = false; const files: string[] = [];
        const count = (v: string) => {
          const m = /^([-+]?)(\d+)$/.exec(v);
          if (!m) throw new ShellError(`${cmd}: invalid number of lines: '${v}'`);
          n = Number(m[2]); from = m[1] === '+'; butLast = m[1] === '-';
        };
        let done = false;
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (done || a === '-' || !a.startsWith('-')) files.push(a);
          else if (a === '--') done = true;
          else if (a === '-n') { if (i + 1 >= args.length) throw needArg('n'); count(args[++i]); }
          else if (a.startsWith('-n')) count(a.slice(2));
          else if (/^-\d+$/.test(a)) count(a.slice(1));
          else if (a.startsWith('--')) throw new ShellError(`${cmd}: unrecognized option '${a}' (this sandbox has no long options)`);
          else throw new ShellError(`${cmd}: invalid option -- '${a[1]}' (this sandbox knows -n and -NUMBER)`);
        }
        // Each file gets its own limit and, with more than one, its own header. Joining
        // them first printed the first ten lines of everything, with no header.
        const r = input(files, cmd, (m) => {
          const [, path, why] = /^\w+: (.*): ([^:]*)$/.exec(m)!;
          return why === 'Is a directory' ? `${cmd}: error reading '${path}': ${why}` : `${cmd}: cannot open '${path}' for reading: ${why}`;
        });
        const pick = (l: string[]) => {
          if (cmd === 'head') return butLast ? l.slice(0, Math.max(0, l.length - n)) : l.slice(0, n);
          return from ? l.slice(Math.max(0, n - 1)) : l.slice(Math.max(0, l.length - n));
        };
        const many = files.length > 1;
        const blocks = r.parts.map((p) => (many ? `==> ${p.name === '-' ? 'standard input' : p.name} <==\n` : '') + joinLines(pick(lines(p.text))));
        return ok(blocks.join(many ? '\n' : ''), r.code);
      }
      case 'cut': {
        let delim: string | null = null, fields: string | null = null, chars: string | null = null; const files: string[] = [];
        let done = false;
        const value = (a: string, i: number, ch: string) => {
          if (a.length > 2) return a.slice(2);
          if (i + 1 >= args.length) throw needArg(ch);
          return args[i + 1];
        };
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (done || a === '-' || !a.startsWith('-')) { files.push(a); continue; }
          if (a === '--') { done = true; continue; }
          if (a.startsWith('--')) throw new ShellError(`cut: unrecognized option '${a}' (this sandbox has no long options)`);
          const ch = a[1];
          if (ch !== 'd' && ch !== 'f' && ch !== 'c') throw new ShellError(`cut: invalid option -- '${ch}' (this sandbox knows -d -f -c)`);
          const v = value(a, i, ch);
          if (a.length === 2) i++;
          if (ch === 'd') delim = v; else if (ch === 'f') fields = v; else chars = v;
        }
        if (fields !== null && chars !== null) throw new ShellError('cut: only one list may be specified');
        if (fields === null && chars === null) throw new ShellError('cut: you must specify a list of bytes, characters, or fields');
        const sep = delim ?? '\t';
        if (sep.length !== 1) throw new ShellError('cut: the delimiter must be a single character');
        const want = parseList(fields ?? chars!, fields !== null ? 'field' : 'character');
        const r = input(files, 'cut');
        const out = lines(r.text).map((l) => {
          if (chars !== null) return [...l].filter((_, i) => want(i + 1)).join('');
          if (!l.includes(sep)) return l;
          return l.split(sep).filter((_, i) => want(i + 1)).join(sep);
        });
        return ok(joinLines(out), r.code);
      }
      case 'bash': case 'sh': {
        if (args[0] === undefined) throw new ShellError(`${cmd}: this sandbox has no nested interactive shell - give it a file: ${cmd} script.sh`);
        // Without this, -c read as a script's file name: "bash: -c: No such file".
        if (args[0] === '-c') throw new ShellError(`${cmd} -c: real bash has it; this sandbox runs scripts from files: ${cmd} script.sh`);
        if (args[0].startsWith('-')) throw new ShellError(`${cmd}: ${args[0]}: invalid option (this sandbox's ${cmd} takes only a file name)`, 2);
        return this.runScript(args[0], args.slice(1), false, ctx);
      }
      default: throw new ShellError(`bash: ${cmd}: command not found`, 127);
    }
  }

  private ls(args: string[], ctx: { tty: boolean; err: (t: string) => void }) {
    const f = new Set<string>(); const paths: string[] = [];
    let done = false;
    for (const a of args) {
      if (done || a === '-' || !a.startsWith('-')) { paths.push(a); continue; }
      if (a === '--') { done = true; continue; }
      if (a.startsWith('--')) throw new ShellError(`ls: unrecognized option '${a}' (this sandbox has no long options)`, 2);
      for (const ch of a.slice(1)) { if (!'la1'.includes(ch)) throw new ShellError(`ls: invalid option -- '${ch}' (this sandbox knows -l -a)`, 2); f.add(ch); }
    }
    if (!paths.length) paths.push('.');
    let code = 0; const blocks: string[] = [];
    const files: [string, Node][] = [], dirs: [string, Dir][] = [];
    for (const p of paths) {
      try {
        const n = this.node(p, 'ls');
        if (n.type === 'dir') dirs.push([p, n]); else files.push([p, n]);
      } catch (e) { if (!(e instanceof ShellError)) throw e; ctx.err(e.message.replace(/^ls: (.*): (.*)$/, "ls: cannot access '$1': $2")); code = 2; }
    }
    const render = (entries: [string, Node][], total: boolean) => {
      if (!f.has('l')) return ctx.tty && !f.has('1') ? (entries.length ? entries.map(([n]) => n).join('  ') + '\n' : '') : joinLines(entries.map(([n]) => n));
      const size = (n: Node) => (n.type === 'dir' ? '4096' : n.device ? '1, 3' : String(bytes(n.content)));
      const links = (n: Node) => (n.type === 'dir' ? 2 + [...n.children.values()].filter((c) => c.type === 'dir').length : 1);
      const ow = Math.max(0, ...entries.map(([, n]) => n.owner.length)), gw = Math.max(0, ...entries.map(([, n]) => n.group.length));
      const sw = Math.max(0, ...entries.map(([, n]) => size(n).length)), lw = Math.max(0, ...entries.map(([, n]) => String(links(n)).length));
      const blocksOf = (n: Node) => (n.type === 'dir' ? 4 : n.device ? 0 : Math.ceil(bytes(n.content) / 4096) * 4);
      const head = total ? [`total ${entries.reduce((s, [, n]) => s + blocksOf(n), 0)}`] : [];
      return joinLines([...head, ...entries.map(([name, n]) => {
        const d = new Date(BASE_TIME + n.mtime * 60000);
        const date = `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        return `${modeString(n)} ${String(links(n)).padStart(lw)} ${n.owner.padEnd(ow)} ${n.group.padEnd(gw)} ${size(n).padStart(sw)} ${date} ${name}`;
      })]);
    };
    if (files.length) blocks.push(render(files.sort((a, b) => cmpC(a[0], b[0])), false));
    for (const [p, d] of dirs.sort((a, b) => cmpC(a[0], b[0]))) {
      if (!canAccess(d, this.user, R)) { ctx.err(`ls: cannot open directory '${p}': Permission denied`); code = 2; continue; }
      const entries: [string, Node][] = [...d.children.entries()].filter(([n]) => f.has('a') || !n.startsWith('.')).sort((a, b) => cmpC(a[0], b[0]));
      if (f.has('a')) entries.unshift(['.', d], ['..', d]);
      const title = paths.length > 1 ? `${p}:\n` : '';
      blocks.push(title + render(entries, true));
    }
    return { out: blocks.join(paths.length > 1 ? '\n' : ''), code };
  }

  private mkdir(path: string, parents: boolean) {
    if (path === '') throw new ShellError("mkdir: cannot create directory '': No such file or directory");
    const parts = Fs.parts(this.abs(path));
    // The loop below never runs for /, so this reported success.
    if (!parts.length) { if (parents) return; throw new ShellError(`mkdir: cannot create directory '${path}': File exists`); }
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur += '/' + parts[i];
      const lastPart = i === parts.length - 1;
      let n: Node | undefined;
      try { n = this.fs.lookup(cur, this.user); } catch (e) { throw new ShellError(`mkdir: cannot create directory '${path}': ${(e as Error).message}`); }
      if (n) {
        if (lastPart && !parents) throw new ShellError(`mkdir: cannot create directory '${path}': File exists`);
        if (n.type !== 'dir') throw new ShellError(`mkdir: cannot create directory '${path}': Not a directory`);
        continue;
      }
      if (!lastPart && !parents) throw new ShellError(`mkdir: cannot create directory '${path}': No such file or directory`);
      const { dir, name } = this.fs.parentOf(cur, this.user);
      if (!canAccess(dir, this.user, W)) throw new ShellError(`mkdir: cannot create directory '${path}': Permission denied`);
      dir.children.set(name, { type: 'dir', mode: 0o755, owner: this.user.name, group: this.user.groups[0].name, mtime: 1, children: new Map() });
    }
  }

  private rm(path: string, recursive: boolean) {
    if (path === '') throw new ShellError("rm: cannot remove '': No such file or directory");
    const abs = this.abs(path);
    // Real rm refuses all of these, and on the lesson that opens with `rm -rf /*` someone
    // will try the first. It used to throw out of parentOf: no output, and status 0.
    if (recursive && abs === '/') throw new ShellError("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe");
    if (/(^|\/)\.\.?\/*$/.test(path)) throw new ShellError(recursive ? `rm: refusing to remove '.' or '..' directory: skipping '${path}'` : `rm: cannot remove '${path}': Is a directory`);
    let n: Node | undefined;
    try { n = this.fs.lookup(abs, this.user); } catch (e) { throw new ShellError(`rm: cannot remove '${path}': ${(e as Error).message}`); }
    if (!n) throw new ShellError(`rm: cannot remove '${path}': No such file or directory`);
    if (n.type === 'dir' && !recursive) throw new ShellError(`rm: cannot remove '${path}': Is a directory`);
    let dir: Dir, name: string;
    try { ({ dir, name } = this.fs.parentOf(abs, this.user)); } catch (e) { throw new ShellError(`rm: cannot remove '${path}': ${(e as Error).message}`); }
    // Deleting is a change to the directory, not the file: you need write on
    // the folder, and the file's own bits do not matter.
    if (!canAccess(dir, this.user, W)) throw new ShellError(`rm: cannot remove '${path}': Permission denied`);
    dir.children.delete(name);
  }

  private exists(path: string) { try { return !!this.fs.lookup(this.abs(path), this.user); } catch { return false; } }
  private isDir(path: string) { try { return this.fs.lookup(this.abs(path), this.user)?.type === 'dir'; } catch { return false; } }

  private copyMove(cmd: string, src: string, dst: string) {
    let s: Node;
    try { s = this.node(src, cmd); }
    catch (e) {
      if (!(e instanceof ShellError)) throw e;
      throw new ShellError(`${cmd}: cannot stat '${src}': ${e.message.slice(`${cmd}: ${src}: `.length)}`);
    }
    if (cmd === 'cp' && s.type === 'dir') throw new ShellError(`cp: -r not specified; omitting directory '${src}'`);
    // Joined to the current folder, an empty target would have meant a file at the root.
    if (dst === '') throw new ShellError(cmd === 'cp' ? "cp: cannot create regular file '': No such file or directory" : "mv: cannot overwrite directory '' with non-directory");
    const srcAbs = this.abs(src);
    let target = dst;
    if (this.isDir(dst)) target = dst.replace(/\/?$/, '/') + Fs.parts(srcAbs).pop();
    const targetAbs = this.abs(target);
    if (srcAbs === targetAbs && s.type !== 'dir') throw new ShellError(`${cmd}: '${src}' and '${target}' are the same file`);
    if (cmd === 'cp') {
      if (!canAccess(s, this.user, R)) throw new ShellError(`cp: cannot open '${src}' for reading: Permission denied`);
      let f: File;
      try { f = this.writeFile(target, s.type === 'file' ? s.content : '', false, 'cp'); }
      catch (e) {
        if (!(e instanceof ShellError)) throw e;
        const why = e.message.slice(`cp: ${target}: `.length);
        throw new ShellError(`cp: cannot create regular file '${target}': ${why}`);
      }
      f.mode = s.mode & 0o755;
    } else {
      // A folder moves like a file; cp's -r rule doesn't apply. It can't go inside itself.
      if (s.type === 'dir' && (targetAbs === srcAbs || targetAbs.startsWith(srcAbs + '/'))) throw new ShellError(`mv: cannot move '${src}' to a subdirectory of itself, '${target}'`);
      const already = this.exists(target) ? this.fs.lookup(targetAbs, this.user) : undefined;
      if (already?.type === 'dir' && s.type !== 'dir') throw new ShellError(`mv: cannot overwrite directory '${target}' with non-directory`);
      if (already && already.type !== 'dir' && s.type === 'dir') throw new ShellError(`mv: cannot overwrite non-directory '${target}' with directory '${src}'`);
      let from: { dir: Dir; name: string }, to: { dir: Dir; name: string };
      try { from = this.fs.parentOf(srcAbs, this.user); to = this.fs.parentOf(targetAbs, this.user); }
      catch (e) { throw new ShellError(`mv: cannot move '${src}' to '${dst}': ${(e as Error).message}`); }
      if (!canAccess(from.dir, this.user, W)) throw new ShellError(`mv: cannot move '${src}' to '${dst}': Permission denied`);
      if (!canAccess(to.dir, this.user, W)) throw new ShellError(`mv: cannot move '${src}' to '${dst}': Permission denied`);
      from.dir.children.delete(from.name);
      to.dir.children.set(to.name, s);
    }
  }

  // bash's printf. It repeats the format while values remain, but only if the format
  // uses any: `printf hi a` used to loop forever here and hang the page.
  private printf(args: string[], ctx: { err: (t: string) => void }) {
    if (!args.length) throw new ShellError('printf: usage: printf format [arguments]', 2);
    if (args[0].startsWith('-') && args[0] !== '--') throw new ShellError(`bash: printf: ${args[0]}: invalid option (this sandbox's printf takes a format first)`, 2);
    const [fmt, ...vals] = args[0] === '--' ? args.slice(1) : args;
    if (fmt === undefined) throw new ShellError('printf: usage: printf format [arguments]', 2);
    let out = '', i = 0, code = 0;
    do {
      const before = i;
      out += fmt.replace(/%(.?)|\\(n|t|\\)/g, (_, f: string | undefined, esc: string | undefined) => {
        if (esc) return esc === 'n' ? '\n' : esc === 't' ? '\t' : '\\';
        if (f === '%') return '%';
        if (f === 's') return vals[i++] ?? '';
        if (f === 'd') {
          const v = vals[i++] ?? '';
          const n = printfNumber(v);
          if (!n.ok) { ctx.err(`bash: printf: ${v}: invalid number`); code = 1; }
          return String(n.value);
        }
        // Printing %x back as text reads as if that's what it does.
        throw new ShellError(`bash: printf: %${f}: real printf may have this; this sandbox knows %s, %d and %%`);
      });
      if (i === before) break;
    } while (i < vals.length);
    return { out, code };
  }

  private chmod(args: string[], ctx: { err: (t: string) => void }) {
    if (!args.length) throw new ShellError('chmod: missing operand');
    if (args.length < 2) throw new ShellError(`chmod: missing operand after '${args[0]}'`);
    const [mode, ...paths] = args;
    applyMode(0, mode, false); // a bad mode is one error, before any file is touched
    let code = 0;
    for (const path of paths) {
      try {
        const n = this.node(path, 'chmod');
        // Only the owner (or root) may change a file's mode, whatever the bits say.
        if (n.owner !== this.user.name && this.user.uid !== 0) throw new ShellError(`chmod: changing permissions of '${path}': Operation not permitted`);
        n.mode = applyMode(n.mode, mode, n.type === 'dir');
      } catch (e) {
        if (!(e instanceof ShellError)) throw e;
        ctx.err(e.message.replace(/^chmod: (.*): (No such file or directory|Not a directory|Permission denied)$/, "chmod: cannot access '$1': $2")); code = 1;
      }
    }
    return { out: '', code };
  }

  private ps(args: string[]) {
    // Anything else used to print the short table as if it had worked.
    for (const a of args) if (!/^(-e|-A|-ef|aux|ax|-aux)$/.test(a)) throw new ShellError(`ps: ${a}: real ps may have this; this sandbox knows ps, ps -e, ps -A, ps -ef and ps aux`);
    const all = args.length > 0;
    if (!all) {
      const mine = [{ pid: this.pid, cmd: 'bash' }, ...[...this.procs.values()].filter((p) => p.alive && p.job).map((p) => ({ pid: p.pid, cmd: p.name })), { pid: this.nextPid, cmd: 'ps' }];
      return { out: joinLines(['    PID TTY          TIME CMD', ...mine.map((p) => `${String(p.pid).padStart(7)} pts/0    00:00:00 ${p.cmd}`)]), code: 0 };
    }
    // A simplified ps -e: real ps aux adds CPU, memory, start time and terminal columns.
    const rows = [{ pid: 1, owner: 'root', cmd: '/sbin/init' }, ...[...this.procs.values()].filter((p) => p.alive && !p.job).map((p) => ({ pid: p.pid, owner: p.owner, cmd: p.cmd })),
      { pid: this.pid, owner: this.user.name, cmd: 'bash' }, ...[...this.procs.values()].filter((p) => p.alive && p.job).map((p) => ({ pid: p.pid, owner: p.owner, cmd: p.cmd })), { pid: this.nextPid, owner: this.user.name, cmd: `ps ${args.join(' ')}` }];
    return { out: joinLines(['USER         PID CMD', ...rows.sort((a, b) => a.pid - b.pid).map((r) => `${r.owner.padEnd(8)} ${String(r.pid).padStart(6)} ${r.cmd}`)]), code: 0 };
  }

  private kill(args: string[]) {
    if (args[0] === '-l') return { out: ' 1) SIGHUP\t 2) SIGINT\t 9) SIGKILL\t15) SIGTERM\n', code: 0 };
    let sig = SIGNALS.TERM; let i = 0;
    const parseSig = (s: string) => {
      const name = s.replace(/^SIG/, '').toUpperCase();
      if (/^\d+$/.test(s) && Object.values(SIGNALS).includes(Number(s))) return Number(s);
      if (SIGNALS[name]) return SIGNALS[name];
      throw new ShellError(`bash: kill: ${s}: invalid signal specification (this sandbox knows HUP INT KILL TERM)`);
    };
    if (args[0] === '-s' && args[1] === undefined) throw new ShellError('bash: kill: -s: option requires an argument');
    if (args[0] === '-s') { sig = parseSig(args[1]); i = 2; }
    else if (args[0]?.startsWith('-')) { sig = parseSig(args[0].slice(1)); i = 1; }
    const targets = args.slice(i);
    if (!targets.length) throw new ShellError('kill: usage: kill [-s sigspec | -sigspec] pid | jobspec ...', 2);
    let code = 0; const errs: string[] = [];
    for (const t of targets) {
      try {
        if (t === '1') throw new ShellError('bash: kill: (1) - Operation not permitted');
        const p = this.findTarget(t);
        if (p.owner !== this.user.name && this.user.uid !== 0) throw new ShellError(`bash: kill: (${p.pid}) - Operation not permitted`);
        this.deliver(p, sig);
      } catch (e) { if (!(e instanceof ShellError)) throw e; errs.push(e.message); code = 1; }
    }
    if (errs.length) throw new ShellError(errs.join('\n'), code);
    return { out: '', code };
  }

  private wait(args: string[]) {
    if (!args.length) { for (const p of this.procs.values()) if (!p.alive) p.job = undefined; return { out: '', code: 0 }; }
    const t = args[0];
    let p: Proc | undefined;
    if (!t.startsWith('%') && !/^\d+$/.test(t)) throw new ShellError(`bash: wait: \`${t}': not a pid or valid job spec`);
    if (t.startsWith('%')) {
      p = [...this.procs.values()].find((x) => x.job === Number(t.slice(1)));
      if (!p) throw new ShellError(`bash: wait: ${t}: no such job`, 127);
    } else {
      p = this.procs.get(Number(t));
      if (!p || !p.child) throw new ShellError(`bash: wait: pid ${t} is not a child of this shell`, 127);
    }
    if (p.alive) {
      this.notes.push({ text: `[sandbox] ${p.cmd} is still running. A real shell would sit here until it ends - stop it first, then wait.`, kind: 'hint' });
      return { out: '', code: this.status };
    }
    p.job = undefined;
    return { out: '', code: p.status ?? 0 };
  }

  private grep({ f, rest }: { f: Set<string>; rest: string[] }, input: (files: string[], who: string) => { code: number; parts: { name: string; text: string }[] }) {
    const [pattern, ...files] = rest;
    if (pattern === undefined) throw new ShellError('Usage: grep [OPTION]... PATTERNS [FILE]... (this sandbox knows -i -v -c -n -E)', 2);
    // grep's default is a basic regex, where + ? | ( ) { } are ordinary characters and
    // the backslashed forms are the operators: the other way round from JavaScript.
    const src = f.has('E') ? pattern : pattern.replace(/\\([+?|(){}])|[+?|(){}]/g, (m, op: string | undefined) => (op ?? `\\${m}`));
    let re: RegExp;
    try { re = new RegExp(src, f.has('i') ? 'i' : ''); } catch { throw new ShellError(`grep: invalid pattern '${pattern}'`, 2); }
    const r = input(files, 'grep');
    const many = files.length > 1;
    let matched = 0; const out: string[] = [];
    for (const part of r.parts) {
      let n = 0;
      lines(part.text).forEach((l, i) => {
        if (re.test(l) === f.has('v')) return;
        n++;
        if (!f.has('c')) out.push(`${many ? part.name + ':' : ''}${f.has('n') ? i + 1 + ':' : ''}${l}`);
      });
      if (f.has('c')) out.push(`${many ? part.name + ':' : ''}${n}`);
      matched += n;
    }
    return { out: joinLines(out), code: r.code === 2 ? 2 : matched ? 0 : 1 };
  }

  /** ./file runs only with the execute bit; bash file needs only read. */
  private runScript(path: string, args: string[], direct: boolean, ctx: { err: (t: string) => void }) {
    let n: Node;
    try { n = this.node(path, 'bash'); } catch (e) { throw new ShellError((e as Error).message, 127); }
    if (n.type === 'dir') throw new ShellError(direct ? `bash: ${path}: Is a directory` : `${path}: ${path}: Is a directory`, 126);
    if (direct && !canAccess(n, this.user, X)) throw new ShellError(`bash: ${path}: Permission denied`, 126);
    if (!canAccess(n, this.user, R)) throw new ShellError(`bash: ${path}: Permission denied`, 126);
    if (this.scriptDepth >= MAX_SCRIPT_DEPTH) throw new ShellError(`bash: ${path}: this sandbox stops at ${MAX_SCRIPT_DEPTH} scripts inside scripts`, 126);
    const text = n.device ? '' : n.content;
    // The first line picks the interpreter only when a file is run directly, and that
    // is why it was silently ignored here: `bash file` really does ignore it.
    const bang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(text);
    if (direct && bang && !BASH_PATHS.has(bang[1]) && !(bang[1] === '/usr/bin/env' && (bang[2] === 'bash' || bang[2] === 'sh'))) {
      throw new ShellError(`bash: ${path}: cannot execute: required file not found`, 127);
    }
    let outs = '';
    let code = 0;
    // A real script runs in a process of its own, so its cd ends with it. Without
    // this, a script that cd'd left the learner's prompt somewhere else.
    // Each line goes through run() again, which starts its own record of what was
    // printed. Those records belong to the command line that started the script:
    // leaving them set wiped output from earlier in a pipeline and doubled the
    // script's own, and a mission reading `outputs` saw every line twice.
    const before = { cwd: this.cwd, oldpwd: this.oldpwd, args: this.args, name: this.scriptName, rawOut: this.rawOut, notes: this.notes, outputs: this.outputs.length };
    const scriptPath = this.abs(path);
    this.args = args;
    this.scriptName = path;
    this.scriptDepth++;
    try {
      for (const [at, l] of lines(text).entries()) {
        if (!l.trim() || l.trim().startsWith('#')) continue;
        const pushed = this.history.length;
        try {
          // Inside a script bash names the script and the line, where at a prompt it
          // says "bash:". That line number is how you find what failed.
          for (const r of this.run(l)) { if (r.kind !== 'out') ctx.err(r.text.replace(/^bash: /, `${path}: line ${at + 1}: `)); }
          // Exactly what the line wrote, not its lines: `printf a` in a script has no
          // newline to add, and a non-interactive bash prints no "[1] 4250" job lines.
          outs += this.rawOut;
        } finally { this.history.length = pushed; }
        code = this.status;
      }
    } catch (e) {
      if (!(e instanceof ScriptExit)) throw e;
      code = e.code;
    } finally {
      this.scriptDepth--;
      this.cwd = before.cwd; this.oldpwd = before.oldpwd; this.args = before.args; this.scriptName = before.name;
      this.rawOut = before.rawOut; this.notes = before.notes; this.outputs.length = before.outputs;
    }
    this.scriptRuns.push({ path: scriptPath, code });
    return { out: outs, code };
  }
}

const ECHO_ESCAPES: Record<string, string> = { '\\': '\\', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
const BASH_PATHS = new Set(['/bin/bash', '/bin/sh', '/usr/bin/bash', '/usr/bin/sh']);

/** %d as bash reads it: 0x10 is hex and 010 octal. What it can't read prints as far as it got, with an error. */
function printfNumber(v: string): { ok: boolean; value: number } {
  const t = v.trim();
  if (t === '') return { ok: true, value: 0 };
  if (/^[-+]?0[xX][0-9a-fA-F]+$/.test(t)) return { ok: true, value: Number(t.replace(/^[-+]/, '')) * (t[0] === '-' ? -1 : 1) };
  if (/^[-+]?0[0-7]*$/.test(t)) return { ok: true, value: parseInt(t, 8) };
  if (/^[-+]?\d+$/.test(t)) return { ok: true, value: parseInt(t, 10) };
  const lead = /^[-+]?\d+/.exec(t);
  return { ok: false, value: lead ? parseInt(lead[0], 10) : 0 };
}

function p0isTilde(w: Word) { return w[0]?.q === 'none' && (w[0].s === '~' || w[0].s.startsWith('~/')); }

// bash pads the state column of a job line to 27 characters.
export function jobLine(job: number, state: string, cmd: string, current = true) {
  return `[${job}]${current ? '+' : '-'}  ${state.padEnd(27)}${cmd}`;
}

export function applyMode(mode: number, spec: string, isDir: boolean): number {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8) & 0o7777;
  let m = mode;
  for (const clause of spec.split(',')) {
    const c = /^([ugoa]*)([-+=])([rwxX]*)$/.exec(clause);
    if (!c) throw new ShellError(`chmod: invalid mode: '${spec}'`);
    const [, who, op, perms] = c;
    // No "who" means all - minus the umask (022), so chmod +w gives only the owner write.
    const umask = who ? 0 : 0o022;
    const classes = (who || 'a').replace('a', 'ugo');
    let bits = 0;
    for (const ch of perms) {
      const b = ch === 'r' ? 4 : ch === 'w' ? 2 : ch === 'x' ? 1 : (isDir || (mode & 0o111) !== 0) ? 1 : 0;
      for (const k of classes) bits |= b << (k === 'u' ? 6 : k === 'g' ? 3 : 0);
    }
    bits &= ~umask;
    if (op === '+') m |= bits;
    else if (op === '-') m &= ~bits;
    else {
      let clear = 0;
      for (const k of classes) clear |= 7 << (k === 'u' ? 6 : k === 'g' ? 3 : 0);
      m = (m & ~clear) | bits;
    }
  }
  return m;
}

function parseList(list: string, kind: 'field' | 'character'): (n: number) => boolean {
  const ranges = list.split(',').map((r) => {
    if (!/^(\d+|\d*-\d*)$/.test(r) || r === '-') throw new ShellError(`cut: invalid ${kind === 'field' ? 'field' : 'byte/character position'} value '${r}'`);
    const [a, b] = r.split('-');
    const lo = a ? Number(a) : 1, hi = r.includes('-') ? (b ? Number(b) : Infinity) : lo;
    if (lo < 1) throw new ShellError(kind === 'field' ? 'cut: fields are numbered from 1' : 'cut: byte/character positions are numbered from 1');
    return [lo, hi] as const;
  });
  return (n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

export function sortLines(l: string[], f: Set<string>): string[] {
  const num = (s: string) => { const m = /^\s*(-?\d+(\.\d+)?)/.exec(s); return m ? Number(m[1]) : 0; };
  // Ties under -n fall back to comparing whole lines, as GNU sort does.
  const cmp = (a: string, b: string) => (f.has('n') ? num(a) - num(b) || cmpC(a, b) : cmpC(a, b));
  const sorted = [...l].sort((a, b) => (f.has('r') ? -cmp(a, b) : cmp(a, b)));
  return f.has('u') ? sorted.filter((x, i) => i === 0 || (f.has('n') ? num(x) !== num(sorted[i - 1]) : x !== sorted[i - 1])) : sorted;
}

export function uniq(l: string[], count: boolean, dupOnly: boolean): string[] {
  const groups: [string, number][] = [];
  for (const x of l) { const g = groups[groups.length - 1]; if (g && g[0] === x) g[1]++; else groups.push([x, 1]); }
  return groups.filter(([, n]) => !dupOnly || n > 1).map(([x, n]) => (count ? `${String(n).padStart(7)} ${x}` : x));
}

export type WcPart = { name: string; text: string; irregular?: boolean };

/** `operands` is how many names were given, which can be more than rows: a missing file has no row. */
export function wc(parts: WcPart[], f: Set<string>, named: boolean, operands = parts.length): string {
  const want = f.size ? f : new Set(['l', 'w', 'c']);
  const counts = (t: string) => ({ l: (t.match(/\n/g) ?? []).length, w: t.split(/\s+/).filter(Boolean).length, c: bytes(t) });
  const rows = parts.map((p) => ({ name: p.name, ...counts(p.text) }));
  if (operands > 1) rows.push({ name: 'total', l: rows.reduce((s, r) => s + r.l, 0), w: rows.reduce((s, r) => s + r.w, 0), c: rows.reduce((s, r) => s + r.c, 0) });
  // The one file named couldn't be read, so its error is all there is to say.
  if (!rows.length) return '';
  const order = ['l', 'w', 'c'].filter((k) => want.has(k)) as ('l' | 'w' | 'c')[];
  // GNU wc: one count of one input is printed bare; otherwise columns are as wide as
  // the total byte count of the files, or at least 7 when something has no known size,
  // such as a pipe or a directory.
  const total = parts.reduce((s, p) => s + bytes(p.text), 0);
  const width = order.length === 1 && operands === 1 ? 1 : !named ? 7 : Math.max(parts.some((p) => p.irregular) ? 7 : 1, String(total).length);
  return joinLines(rows.map((r) => order.map((k) => String(r[k]).padStart(width)).join(' ') + (r.name ? ' ' + r.name : '')));
}

// ---- parsing ----------------------------------------------------------------

type Tok = { op: string } | { word: Word };

export function tokenize(line: string): Tok[] {
  const toks: Tok[] = [];
  let cur: Word | null = null;
  const part = (q: Part['q']) => {
    cur ??= [];
    const last = cur[cur.length - 1];
    if (last && last.q === q) return last;
    const p: Part = { s: '', q }; cur.push(p); return p;
  };
  const end = () => { if (cur) { toks.push({ word: cur }); cur = null; } };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') { end(); continue; }
    if (ch === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) throw new Error('unexpected EOF while looking for matching `\'\'');
      part('single').s += line.slice(i + 1, j); i = j; continue;
    }
    if (ch === '"') {
      let j = i + 1, s = '';
      while (j < line.length && line[j] !== '"') { if (line[j] === '\\' && /["\\$`]/.test(line[j + 1] ?? '')) j++; s += line[j]; j++; }
      if (j >= line.length) throw new Error('unexpected EOF while looking for matching `""');
      part('double').s += s; i = j; continue;
    }
    if (ch === '\\') { part('single').s += line[i + 1] ?? ''; i++; continue; }
    // These parsed as a confusing syntax error or as part of a word. Refused by name.
    if (/^([12]?>&|&>)/.test(line.slice(i)) && !cur) throw new Error(`${/^([12]?>&\S*|&>)/.exec(line.slice(i))![0]}: real bash can join output streams; this sandbox has only > >> < 2> and 2>>`);
    if (ch === '(' || ch === ')') throw new Error(`${ch}: real bash has subshells and arrays; this sandbox does not`);
    if (ch === '2' && line[i + 1] === '>' && !cur) { end(); const app = line[i + 2] === '>'; toks.push({ op: app ? '2>>' : '2>' }); i += app ? 2 : 1; continue; }
    const two = line.slice(i, i + 2);
    if (['&&', '||', '>>'].includes(two)) { end(); toks.push({ op: two }); i++; continue; }
    if ('|&;<>'.includes(ch)) { end(); toks.push({ op: ch }); continue; }
    if (ch === '#' && !cur) break;
    part('none').s += ch;
  }
  end();
  return toks;
}

export function parse(toks: Tok[]): ListItem[] {
  const items: ListItem[] = [];
  let cmds: Command[] = [], cur: Command = { words: [], redirects: [] };
  const finishCmd = () => {
    if (!cur.words.length && !cur.redirects.length) throw new Error('syntax error near unexpected token');
    cmds.push(cur); cur = { words: [], redirects: [] };
  };
  let lastOp = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    lastOp = 'word' in t ? '' : t.op;
    if ('word' in t) { cur.words.push(t.word); continue; }
    const op = t.op;
    if (op === '>' || op === '>>' || op === '<' || op === '2>' || op === '2>>') {
      const next = toks[++i];
      if (!next || !('word' in next)) throw new Error(`syntax error near unexpected token \`newline'`);
      cur.redirects.push({ fd: op === '<' ? 0 : op.startsWith('2') ? 2 : 1, append: op.endsWith('>>'), target: next.word });
      continue;
    }
    if (op === '|') { finishCmd(); continue; }
    finishCmd();
    items.push({ pipeline: { cmds, background: op === '&' }, op: op as ListItem['op'] });
    cmds = [];
  }
  if (['|', '&&', '||'].includes(lastOp)) throw new Error(`syntax error: nothing after \`${lastOp}'`);
  if (cur.words.length || cur.redirects.length) cmds.push(cur);
  if (cmds.length) items.push({ pipeline: { cmds, background: false }, op: null });
  return items;
}
