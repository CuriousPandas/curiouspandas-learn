// A Dockerfile build cache you can watch. Two rules from Docker's own docs
// (docs.docker.com/build/cache/invalidation/) do all the work:
//
//  - RUN is matched on its command string alone. The builder never looks at
//    what the command would download, which is why `RUN apt-get update` can
//    serve a months-old package list from cache.
//  - COPY is matched on a checksum of the files it copies, so editing one of
//    them misses the cache.
//
// Each step's key also includes the key of the step before it. That chaining
// is what makes one miss rebuild everything after it - the cascade the docs
// describe and the reason instruction order matters. tests/docker.test.ts
// pins both rules and the cascade.

import { sha1 } from '../git/sha1.ts';

export type Step = { text: string; op: string; key: string; cached: boolean; seconds: number; copies: string[] };
export type Build = { steps: Step[]; seconds: number; error?: string };

const enc = new TextEncoder();
const h = (s: string) => sha1(enc.encode(s)).slice(0, 12);

// Pretend durations, only so the totals mean something. The shape matters
// (installing dependencies is the slow step), not the numbers.
function cost(op: string, args: string) {
  if (op === 'RUN' && /\b(npm (ci|install)|pip install|apt-get install)\b/.test(args)) return 45;
  if (op === 'RUN' && /\b(build|compile)\b/.test(args)) return 12;
  if (op === 'RUN') return 4;
  if (op === 'COPY') return 1;
  return 0;
}

/** Which context files a COPY source pattern picks up. */
export function matchSources(src: string, files: string[]): string[] {
  const s = src.replace(/^\.\//, '');
  if (s === '.' || s === '') return files;
  if (s.endsWith('/')) return files.filter((f) => f.startsWith(s));
  if (s.includes('*')) {
    const re = new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
    return files.filter((f) => re.test(f));
  }
  return files.filter((f) => f === s || f.startsWith(s + '/'));
}

const KNOWN = new Set(['FROM', 'WORKDIR', 'COPY', 'ADD', 'RUN', 'ENV', 'ARG', 'EXPOSE', 'CMD', 'ENTRYPOINT', 'USER', 'LABEL']);

export function build(dockerfile: string, files: Record<string, string>, cache: Set<string>, dockerignore: string[] = []): Build {
  const context = Object.keys(files).filter((f) => !dockerignore.some((ig) => f === ig || f.startsWith(ig.replace(/\/?$/, '/')))).sort();
  const steps: Step[] = [];
  let parent = 'scratch';
  const lines = dockerfile.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length || !/^FROM\s/i.test(lines[0])) return { steps, seconds: 0, error: 'A Dockerfile has to start with FROM.' };
  for (const line of lines) {
    const m = /^(\w+)\s+(.*)$/.exec(line);
    if (!m) return { steps, seconds: 0, error: `Cannot read "${line}".` };
    const op = m[1].toUpperCase(), args = m[2];
    if (!KNOWN.has(op)) return { steps, seconds: 0, error: `Unknown instruction ${m[1]}.` };
    let copies: string[] = [];
    let content = '';
    if (op === 'COPY' || op === 'ADD') {
      const parts = args.split(/\s+/);
      if (parts.length < 2) return { steps, seconds: 0, error: `${op} needs a source and a destination.` };
      copies = [...new Set(parts.slice(0, -1).flatMap((s) => matchSources(s, context)))].sort();
      if (!copies.length) return { steps, seconds: 0, error: `${op} ${parts.slice(0, -1).join(' ')}: no such file in the build context${dockerignore.length ? ' (is it in .dockerignore?)' : ''}.` };
      content = copies.map((f) => `${f}:${h(files[f])}`).join(',');
    }
    const key = h(`${parent}|${op} ${args}|${content}`);
    const cached = cache.has(key);
    steps.push({ text: line, op, key, cached, seconds: cached ? 0 : cost(op, args), copies });
    parent = key;
  }
  for (const s of steps) cache.add(s.key);
  return { steps, seconds: steps.reduce((n, s) => n + s.seconds, 0) };
}

export const NAIVE = `FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build
CMD ["node", "dist/server.js"]`;

export const FRIENDLY = `FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["node", "dist/server.js"]`;

export const PROJECT: Record<string, string> = {
  'package.json': '{ "name": "bamboo-api", "dependencies": { "express": "^5.0.0" } }',
  'package-lock.json': 'lockfile v1',
  'src/server.js': 'app.get("/", (req, res) => res.send("hello"))',
  'src/routes.js': 'export const routes = ["/"]',
  'README.md': '# Bamboo API',
};
