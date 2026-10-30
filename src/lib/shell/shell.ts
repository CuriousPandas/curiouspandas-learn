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
};

const HELP = `This sandbox knows:
  files      pwd cd ls [-l -a] cat echo printf mkdir [-p] touch rm [-r -f] cp mv tee
  people     whoami id hostname chmod
  processes  ps [-e] kill [-TERM -KILL -INT -l] sleep N [&] jobs wait
  text       grep [-i -v -c -n -E] wc [-l -w -c] sort [-r -n -u] uniq [-c -d] head tail cut
  shell      | > >> < 2> && || ; &   $? $! $$ $USER $HOME   bash FILE  ./FILE  history true false
Time stands still here: sleep returns at once, and background jobs run until stopped.`;

const BASE_TIME = Date.UTC(2026, 9, 30, 9, 0); // ls -l dates: Oct 30 09:00
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const bytes = (s: string) => new TextEncoder().encode(s).length;
const lines = (s: string) => { const l = s.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
const joinLines = (l: string[]) => (l.length ? l.join('\n') + '\n' : '');
// sort and ls compare bytes, as in the C locale. Real tools follow your locale,
// which can order "B" and "a" the other way round.
const cmpC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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
      out.push(...this.runPipeline(list[i].pipeline, list[i].op === '&'));
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
        const redir = c.redirects.map((r) => ({ ...r, path: this.expand(r.target).join(' ') }));
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
    const argv = p.cmds[0].words.flatMap((w) => this.expand(w));
    const job = this.nextJob++, pid = this.nextPid++;
    const cmd = argv.join(' ');
    out.push({ text: `[${job}] ${pid}`, kind: 'out' });
    this.lastBg = pid;
    this.status = 0;
    if (p.cmds.length === 1 && argv[0] === 'sleep') {
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
      default: return '';
    }
  }

  private expand(w: Word): string[] {
    let text = '';
    let globbable = false;
    for (const p of w) {
      const s = p.q === 'single' ? p.s : p.s.replace(/\$(\?|!|\$|[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_?!$][A-Za-z0-9_]*\})/g, (_, n: string) => this.vars(n.replace(/^\{|\}$/g, '')));
      if (p.q === 'none' && /[*?]/.test(s)) globbable = true;
      text += s;
    }
    if (p0isTilde(w)) text = this.home + text.slice(1);
    if (!globbable) return [text];
    const matches = this.glob(text);
    return matches.length ? matches : [text];
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
    const flags = (allowed: string) => {
      const f = new Set<string>(), rest: string[] = [];
      for (const a of args) {
        if (/^-[A-Za-z]+$/.test(a) && rest.length === 0) for (const ch of a.slice(1)) {
          if (!allowed.includes(ch)) throw new ShellError(`${cmd}: invalid option -- '${ch}' (this sandbox knows -${allowed.split('').join(' -')})`);
          f.add(ch);
        } else rest.push(a);
      }
      return { f, rest };
    };
    const input = (files: string[], who: string) => {
      if (!files.length) return { text: ctx.stdin ?? '', code: 0, parts: [{ name: '', text: ctx.stdin ?? '' }] };
      let code = 0; const parts: { name: string; text: string }[] = [];
      for (const f of files) {
        try { parts.push({ name: f, text: this.readFile(f, who) }); }
        catch (e) { if (!(e instanceof ShellError)) throw e; ctx.err(e.message); code = who === 'grep' ? 2 : 1; }
      }
      return { text: parts.map((p) => p.text).join(''), code, parts };
    };
    const ok = (out: string, code = 0) => ({ out, code });

    if (cmd.includes('/')) return this.runScript(cmd, true, ctx);
    if (REFUSED[cmd]) throw new ShellError(REFUSED[cmd], 127);

    switch (cmd) {
      case 'help': return ok(HELP + '\n');
      case 'pwd': return ok(this.cwd + '\n');
      case 'true': return ok('');
      case 'false': return ok('', 1);
      case 'whoami': return ok(this.user.name + '\n');
      case 'hostname': return ok('bamboo\n');
      case 'id': {
        const g = this.user.groups;
        return ok(`uid=${this.user.uid}(${this.user.name}) gid=${g[0].gid}(${g[0].name}) groups=${g.map((x) => `${x.gid}(${x.name})`).join(',')}\n`);
      }
      case 'history': return ok(this.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\n') + '\n');
      case 'cd': {
        const target = args[0] === '-' ? this.oldpwd : args[0] ?? this.home;
        const abs = this.abs(target);
        let n: Node | undefined;
        try { n = this.fs.lookup(abs, this.user); } catch (e) { throw new ShellError(`bash: cd: ${target}: ${(e as Error).message}`); }
        if (!n) throw new ShellError(`bash: cd: ${target}: No such file or directory`);
        if (n.type !== 'dir') throw new ShellError(`bash: cd: ${target}: Not a directory`);
        if (!canAccess(n, this.user, X)) throw new ShellError(`bash: cd: ${target}: Permission denied`);
        this.oldpwd = this.cwd; this.cwd = abs;
        return ok(args[0] === '-' ? abs + '\n' : '');
      }
      case 'ls': return this.ls(args, ctx);
      case 'cat': { const r = input(args, 'cat'); return ok(r.text, r.code); }
      case 'echo': {
        const noNl = args[0] === '-n';
        const words = noNl ? args.slice(1) : args;
        const text = words.join(' ');
        if (this.history.length && /\$\?/.test(this.history[this.history.length - 1]) && /^\d+$/.test(text)) this.echoedStatus.push(Number(text));
        return ok(text + (noNl ? '' : '\n'));
      }
      case 'printf': {
        if (!args.length) throw new ShellError('printf: usage: printf format [arguments]', 2);
        const [fmt, ...vals] = args;
        let out = '', i = 0;
        do {
          out += fmt.replace(/%([sd%])|\\(n|t|\\)/g, (_, f: string, esc: string) => {
            if (esc) return esc === 'n' ? '\n' : esc === 't' ? '\t' : '\\';
            if (f === '%') return '%';
            const v = vals[i++] ?? '';
            return f === 'd' ? String(parseInt(v, 10) || 0) : v;
          });
        } while (i < vals.length);
        return ok(out);
      }
      case 'mkdir': {
        const { f, rest } = flags('p');
        let code = 0;
        for (const path of rest) {
          try { this.mkdir(path, f.has('p')); } catch (e) { if (!(e instanceof ShellError)) throw e; ctx.err(e.message); code = 1; }
        }
        return ok('', code);
      }
      case 'touch': {
        let code = 0;
        for (const path of args) {
          try {
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
        const { f, rest } = flags('rf');
        let code = 0;
        for (const path of rest) {
          try { this.rm(path, f.has('r')); }
          catch (e) {
            if (!(e instanceof ShellError)) throw e;
            if (f.has('f') && /No such file/.test(e.message)) continue;
            ctx.err(e.message); code = 1;
          }
        }
        return ok('', code);
      }
      case 'cp': case 'mv': {
        if (args.length !== 2) throw new ShellError(`${cmd}: this sandbox copies one file at a time: ${cmd} SOURCE DEST`);
        this.copyMove(cmd, args[0], args[1]);
        return ok('');
      }
      case 'tee': {
        const { f, rest } = flags('a');
        for (const path of rest) this.writeFile(path, ctx.stdin ?? '', f.has('a'), 'tee');
        return ok(ctx.stdin ?? '');
      }
      case 'chmod': return this.chmod(args, ctx);
      case 'ps': return this.ps(args);
      case 'kill': return this.kill(args);
      case 'sleep': {
        if (!args[0] || !/^\d+(\.\d+)?$/.test(args[0])) throw new ShellError('sleep: missing operand', 1);
        return ok('');
      }
      case 'jobs': {
        const live = [...this.procs.values()].filter((p) => p.job && p.alive);
        return ok(live.map((p, i) => jobLine(p.job!, 'Running', p.cmd + ' &', i === live.length - 1)).join('\n') + (live.length ? '\n' : ''));
      }
      case 'wait': return this.wait(args);
      case 'grep': return this.grep(flags('ivcnE'), input);
      case 'wc': {
        const { f, rest } = flags('lwc');
        const r = input(rest, 'wc');
        return ok(wc(r.parts, f, rest.length > 0), r.code);
      }
      case 'sort': {
        const { f, rest } = flags('rnu');
        const r = input(rest, 'sort');
        return ok(joinLines(sortLines(lines(r.text), f)), r.code);
      }
      case 'uniq': {
        const { f, rest } = flags('cd');
        const r = input(rest, 'uniq');
        return ok(joinLines(uniq(lines(r.text), f.has('c'), f.has('d'))), r.code);
      }
      case 'head': case 'tail': {
        let n = 10, from = false; const files: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '-n') { const v = args[++i] ?? ''; from = v.startsWith('+'); n = parseInt(v, 10); }
          else if (/^-\d+$/.test(a)) n = Number(a.slice(1));
          else files.push(a);
        }
        if (Number.isNaN(n)) throw new ShellError(`${cmd}: invalid number of lines`);
        const r = input(files, cmd);
        const l = lines(r.text);
        const picked = cmd === 'head' ? l.slice(0, n) : from ? l.slice(Math.max(0, n - 1)) : l.slice(Math.max(0, l.length - n));
        return ok(joinLines(picked), r.code);
      }
      case 'cut': {
        let delim = '\t', fields = '', chars = ''; const files: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '-d') delim = args[++i] ?? '';
          else if (a.startsWith('-d')) delim = a.slice(2);
          else if (a === '-f') fields = args[++i] ?? '';
          else if (a.startsWith('-f')) fields = a.slice(2);
          else if (a === '-c') chars = args[++i] ?? '';
          else if (a.startsWith('-c')) chars = a.slice(2);
          else files.push(a);
        }
        if (!fields && !chars) throw new ShellError('cut: you must specify a list of bytes, characters, or fields');
        if (delim.length !== 1) throw new ShellError('cut: the delimiter must be a single character');
        const r = input(files, 'cut');
        const want = parseList(fields || chars);
        const out = lines(r.text).map((l) => {
          if (chars) return [...l].filter((_, i) => want(i + 1)).join('');
          if (!l.includes(delim)) return l;
          return l.split(delim).filter((_, i) => want(i + 1)).join(delim);
        });
        return ok(joinLines(out), r.code);
      }
      case 'bash': case 'sh': {
        if (!args[0]) throw new ShellError(`${cmd}: this sandbox has no nested interactive shell - give it a file: ${cmd} script.sh`);
        return this.runScript(args[0], false, ctx);
      }
      default: throw new ShellError(`bash: ${cmd}: command not found`, 127);
    }
  }

  private ls(args: string[], ctx: { tty: boolean; err: (t: string) => void }) {
    const f = new Set<string>(); const paths: string[] = [];
    for (const a of args) {
      if (/^-[A-Za-z1]+$/.test(a)) for (const ch of a.slice(1)) { if (!'la1'.includes(ch)) throw new ShellError(`ls: invalid option -- '${ch}' (this sandbox knows -l -a)`, 2); f.add(ch); }
      else paths.push(a);
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
    const parts = Fs.parts(this.abs(path));
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
    const abs = this.abs(path);
    let n: Node | undefined;
    try { n = this.fs.lookup(abs, this.user); } catch (e) { throw new ShellError(`rm: cannot remove '${path}': ${(e as Error).message}`); }
    if (!n) throw new ShellError(`rm: cannot remove '${path}': No such file or directory`);
    if (n.type === 'dir' && !recursive) throw new ShellError(`rm: cannot remove '${path}': Is a directory`);
    const { dir, name } = this.fs.parentOf(abs, this.user);
    // Deleting is a change to the directory, not the file: you need write on
    // the folder, and the file's own bits do not matter.
    if (!canAccess(dir, this.user, W)) throw new ShellError(`rm: cannot remove '${path}': Permission denied`);
    dir.children.delete(name);
  }

  private copyMove(cmd: string, src: string, dst: string) {
    const s = this.node(src, cmd);
    if (s.type === 'dir') throw new ShellError(`${cmd}: -r not specified; omitting directory '${src}'`);
    let target = dst;
    try { const d = this.fs.lookup(this.abs(dst), this.user); if (d?.type === 'dir') target = dst.replace(/\/?$/, '/') + Fs.parts(this.abs(src)).pop(); } catch { /* reported by writeFile */ }
    if (cmd === 'cp') {
      if (!canAccess(s, this.user, R)) throw new ShellError(`cp: cannot open '${src}' for reading: Permission denied`);
      const f = this.writeFile(target, s.content, false, 'cp');
      f.mode = s.mode & 0o755;
    } else {
      const from = this.fs.parentOf(this.abs(src), this.user);
      if (!canAccess(from.dir, this.user, W)) throw new ShellError(`mv: cannot move '${src}' to '${dst}': Permission denied`);
      const to = this.fs.parentOf(this.abs(target), this.user);
      if (!canAccess(to.dir, this.user, W)) throw new ShellError(`mv: cannot move '${src}' to '${dst}': Permission denied`);
      from.dir.children.delete(from.name);
      to.dir.children.set(to.name, s);
    }
  }

  private chmod(args: string[], ctx: { err: (t: string) => void }) {
    if (args.length < 2) throw new ShellError('chmod: missing operand');
    const [mode, ...paths] = args;
    let code = 0;
    for (const path of paths) {
      try {
        const n = this.node(path, 'chmod');
        // Only the owner (or root) may change a file's mode, whatever the bits say.
        if (n.owner !== this.user.name && this.user.uid !== 0) throw new ShellError(`chmod: changing permissions of '${path}': Operation not permitted`);
        n.mode = applyMode(n.mode, mode, n.type === 'dir');
      } catch (e) {
        if (!(e instanceof ShellError)) throw e;
        ctx.err(e.message.replace(/^chmod: (.*): No such file or directory$/, "chmod: cannot access '$1': No such file or directory")); code = 1;
      }
    }
    return { out: '', code };
  }

  private ps(args: string[]) {
    const all = args.some((a) => /^(-e|-A|-ef|aux|ax|-aux)$/.test(a));
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
    if (args[0] === '-s') { sig = parseSig(args[1] ?? ''); i = 2; }
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
    if (pattern === undefined) throw new ShellError('grep: usage: grep [-ivcnE] PATTERN [FILE]...', 2);
    // grep's default is a basic regex, where + ? | ( ) { } are ordinary characters.
    const src = f.has('E') ? pattern : pattern.replace(/[+?|(){}]/g, '\\$&');
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
  private runScript(path: string, direct: boolean, ctx: { err: (t: string) => void }) {
    const who = direct ? 'bash' : 'bash';
    let n: Node;
    try { n = this.node(path, who); } catch (e) { throw new ShellError((e as Error).message, 127); }
    if (n.type === 'dir') throw new ShellError(`bash: ${path}: Is a directory`, 126);
    if (direct && !canAccess(n, this.user, X)) throw new ShellError(`bash: ${path}: Permission denied`, 126);
    if (!canAccess(n, this.user, R)) throw new ShellError(`bash: ${path}: Permission denied`, 126);
    const outs: string[] = [];
    let code = 0;
    for (const l of lines(n.device ? '' : n.content)) {
      if (!l.trim() || l.trim().startsWith('#')) continue;
      const exit = /^exit(?:\s+(\d+))?$/.exec(l.trim());
      if (exit) { code = Number(exit[1] ?? this.status); break; }
      for (const r of this.run(l)) { if (r.kind === 'err') ctx.err(r.text); else outs.push(r.text); }
      this.history.pop();
      code = this.status;
    }
    this.scriptRuns.push({ path: this.abs(path), code });
    return { out: joinLines(outs), code };
  }
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

function parseList(list: string): (n: number) => boolean {
  const ranges = list.split(',').map((r) => {
    const [a, b] = r.split('-');
    const lo = a ? Number(a) : 1, hi = r.includes('-') ? (b ? Number(b) : Infinity) : lo;
    if (Number.isNaN(lo) || Number.isNaN(hi)) throw new ShellError(`cut: invalid field value '${r}'`);
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

export function wc(parts: { name: string; text: string }[], f: Set<string>, named: boolean): string {
  const want = f.size ? f : new Set(['l', 'w', 'c']);
  const counts = (t: string) => ({ l: (t.match(/\n/g) ?? []).length, w: t.split(/\s+/).filter(Boolean).length, c: bytes(t) });
  const rows = parts.map((p) => ({ name: p.name, ...counts(p.text) }));
  if (rows.length > 1) rows.push({ name: 'total', l: rows.reduce((s, r) => s + r.l, 0), w: rows.reduce((s, r) => s + r.w, 0), c: rows.reduce((s, r) => s + r.c, 0) });
  const order = ['l', 'w', 'c'].filter((k) => want.has(k)) as ('l' | 'w' | 'c')[];
  // GNU wc: one count of one input is printed bare; otherwise columns are as
  // wide as the total byte count of the files, or 7 when reading a pipe.
  const width = order.length === 1 && parts.length === 1 ? 1 : named ? String(rows[rows.length - 1].c).length : 7;
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
