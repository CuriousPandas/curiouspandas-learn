// An in-memory filesystem with real Unix permission rules: owner, group and
// other classes, checked in that order, with the first matching class deciding
// (path_resolution(7)). That order is the trap the permissions lesson is built
// on: an owner whose own bits are empty is refused even when "other" may read.

export type Base = { mode: number; owner: string; group: string; mtime: number };
export type File = Base & { type: 'file'; content: string; device?: 'null' };
export type Dir = Base & { type: 'dir'; children: Map<string, Node> };
export type Node = File | Dir;

export type User = { name: string; uid: number; groups: { name: string; gid: number }[] };
export const USERS: Record<string, User> = {
  root: { name: 'root', uid: 0, groups: [{ name: 'root', gid: 0 }] },
  panda: { name: 'panda', uid: 1000, groups: [{ name: 'panda', gid: 1000 }, { name: 'dev', gid: 1001 }] },
  web: { name: 'web', uid: 33, groups: [{ name: 'web', gid: 33 }] },
};

export const R = 4, W = 2, X = 1;

export class FsError extends Error {}

export function canAccess(n: Node, user: User, bit: number): boolean {
  // root skips read/write checks; execute still needs some x bit on a file.
  if (user.uid === 0) return n.type === 'dir' || bit !== X || (n.mode & 0o111) !== 0;
  const cls = n.owner === user.name ? (n.mode >> 6) & 7
    : user.groups.some((g) => g.name === n.group) ? (n.mode >> 3) & 7
    : n.mode & 7;
  return (cls & bit) !== 0;
}

export function modeString(n: Node): string {
  const t = n.type === 'dir' ? 'd' : n.device ? 'c' : '-';
  const bits = 'rwxrwxrwx'.split('').map((c, i) => (n.mode & (1 << (8 - i)) ? c : '-')).join('');
  return t + bits;
}

export class Fs {
  root: Dir;
  constructor() {
    this.root = { type: 'dir', mode: 0o755, owner: 'root', group: 'root', mtime: 0, children: new Map() };
  }

  static parts(path: string): string[] {
    return path.split('/').filter((p) => p && p !== '.');
  }

  /** Absolute, normalised path; `..` above / stays at /. */
  static normalize(cwd: string, path: string, home: string): string {
    let p = path;
    if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
    const stack = p.startsWith('/') ? [] : Fs.parts(cwd);
    for (const part of Fs.parts(p)) {
      if (part === '..') stack.pop(); else stack.push(part);
    }
    return '/' + stack.join('/');
  }

  /** Walks to a node, checking search (x) permission on every directory passed through. */
  lookup(abs: string, user: User): Node | undefined {
    let n: Node = this.root;
    for (const part of Fs.parts(abs)) {
      if (n.type !== 'dir') throw new FsError('Not a directory');
      if (!canAccess(n, user, X)) throw new FsError('Permission denied');
      const next: Node | undefined = n.children.get(part);
      if (!next) return undefined;
      n = next;
    }
    return n;
  }

  parentOf(abs: string, user: User): { dir: Dir; name: string } {
    const parts = Fs.parts(abs);
    const name = parts.pop();
    if (!name) throw new FsError('Is a directory');
    const dir = this.lookup('/' + parts.join('/'), user);
    if (!dir) throw new FsError('No such file or directory');
    if (dir.type !== 'dir') throw new FsError('Not a directory');
    if (!canAccess(dir, user, X)) throw new FsError('Permission denied');
    return { dir, name };
  }

  /** Builder used by mission setups; no permission checks. */
  put(abs: string, node: Partial<Node> & { type: Node['type'] }, owner = 'panda'): Node {
    const parts = Fs.parts(abs);
    let d = this.root;
    for (const part of parts.slice(0, -1)) {
      let next = d.children.get(part);
      if (!next) { next = { type: 'dir', mode: 0o755, owner, group: owner, mtime: 0, children: new Map() }; d.children.set(part, next); }
      if (next.type !== 'dir') throw new Error(`${part} is a file`);
      d = next;
    }
    const base = { mode: node.type === 'dir' ? 0o755 : 0o644, owner, group: owner, mtime: 0 };
    const full = (node.type === 'dir' ? { ...base, children: new Map(), ...node } : { ...base, content: '', ...node }) as Node;
    d.children.set(parts[parts.length - 1], full);
    return full;
  }
}
