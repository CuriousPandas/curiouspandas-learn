// Every id a learner's progress can be stored under, read from the source.
// tests/progress-ids.json is the list of ids ever shipped; the test compares
// the two so a renamed id cannot strand anyone's progress unnoticed.
//
//   node scripts/progress-ids.ts --write    add newly shipped ids to the list
//
// --write only ever adds. Removing an id from the list would hide exactly the
// problem it exists to catch; a gone id goes in src/lib/progress-renames.ts.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Kind } from '../src/lib/progress-renames.ts';

const ROOT = join(import.meta.dirname, '..');
export const LIST = join(ROOT, 'tests', 'progress-ids.json');

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

// Where each award() call gets its id. A new file that awards progress has to
// be added here deliberately, or the collector below would not know where its
// ids come from and a rename there would go unchecked.
export const AWARD_SITES: Record<string, string> = {
  'src/pages/learn/[track]/[lesson].astro': 'lessons: the lesson path',
  'src/components/Quiz.astro': 'quizzes: <Quiz id> in lessons',
  'src/components/DoItForReal.astro': 'real: <DoItForReal id> in lessons',
  'src/lib/ui.ts': 'missions: Mission objects exported from src/lib',
  'src/lib/expedition-progress.ts': 'missions: expedition-<id> for each ready expedition in src/data/expeditions.ts',
  'src/components/NeuralPlayground.astro': 'missions: challenge= props in lessons',
  'src/components/DnsLab.astro': 'missions: mission= props in lessons',
  'src/components/GitOpsSim.astro': 'missions: mission= props in lessons',
  'src/components/HashLab.astro': 'missions: mission= props in lessons',
  'src/components/KVCacheSim.astro': 'missions: mission= props in lessons',
  'src/components/LayerCache.astro': 'missions: mission= props in lessons',
  'src/components/LbLab.astro': 'missions: mission= props in lessons',
  'src/components/ScrapeSim.astro': 'missions: mission= props in lessons',
  'src/components/SqlLab.astro': 'missions: mission= props in lessons',
  'src/components/SubnetLab.astro': 'missions: mission= props in lessons',
  'src/components/TcpLab.astro': 'missions: mission= props in lessons',
  'src/components/XssLab.astro': 'missions: mission= props in lessons',
};

export function awardSites(): string[] {
  return walk(join(ROOT, 'src'))
    .filter((p) => /\.(ts|astro)$/.test(p) && /\baward\('/.test(readFileSync(p, 'utf8')))
    .map((p) => relative(ROOT, p).replaceAll('\\', '/'))
    .filter((p) => p !== 'src/lib/progress.ts')
    .sort();
}

const isMission = (x: any) => x && typeof x === 'object' && typeof x.id === 'string' && Array.isArray(x.steps);

export async function collect(): Promise<Record<Kind, string[]>> {
  const out: Record<Kind, Set<string>> = { lessons: new Set(), quizzes: new Set(), missions: new Set(), real: new Set() };
  const dupes: string[] = [];
  const add = (k: Kind, id: string, where: string) => {
    if (out[k].has(id) && k !== 'missions') dupes.push(`${k} "${id}" (again in ${where})`);
    out[k].add(id);
  };

  const lessonDir = join(ROOT, 'src', 'content', 'lessons');
  for (const f of walk(lessonDir).filter((p) => p.endsWith('.mdx'))) {
    const rel = relative(lessonDir, f).replaceAll('\\', '/');
    add('lessons', rel.replace(/\.mdx$/, ''), rel);
    const src = readFileSync(f, 'utf8');
    // Count the tags as well as the ids: a tag whose id this pattern misses
    // (written id={...}, or id not first) would otherwise drop out unseen.
    for (const [tag, kind] of [['Quiz', 'quizzes'], ['DoItForReal', 'real']] as const) {
      const ids = [...src.matchAll(new RegExp(`<${tag}\\s+id="([^"]+)"`, 'g'))].map((m) => m[1]);
      const tags = src.match(new RegExp(`<${tag}\\b`, 'g'))?.length ?? 0;
      if (ids.length !== tags) throw new Error(`${rel}: ${tags} <${tag}> tags but ${ids.length} read as <${tag} id="...">`);
      for (const id of ids) add(kind, id, rel);
    }
    for (const m of src.matchAll(/\b(?:mission|challenge)="([^"]+)"/g)) add('missions', m[1], rel);
  }

  const libDir = join(ROOT, 'src', 'lib');
  for (const f of walk(libDir).filter((p) => p.endsWith('.ts') && /Mission</.test(readFileSync(p, 'utf8')))) {
    const mod = await import(pathToFileURL(f).href);
    for (const v of Object.values(mod)) {
      if (isMission(v)) add('missions', (v as any).id, relative(ROOT, f));
      else if (v && typeof v === 'object') for (const w of Object.values(v as object)) if (isMission(w)) add('missions', (w as any).id, relative(ROOT, f));
    }
  }

  // A finished expedition's bonus XP is stored as a mission.
  const { EXPEDITIONS } = await import(pathToFileURL(join(ROOT, 'src', 'data', 'expeditions.ts')).href);
  for (const e of EXPEDITIONS) if (e.status === 'ready') add('missions', `expedition-${e.id}`, 'src/data/expeditions.ts');

  // Two quizzes sharing an id share one tick: solving either marks both.
  if (dupes.length) throw new Error(`Progress ids used twice:\n  ${dupes.join('\n  ')}`);
  return Object.fromEntries(Object.entries(out).map(([k, s]) => [k, [...s].sort()])) as Record<Kind, string[]>;
}

export function shipped(): Record<Kind, string[]> {
  return JSON.parse(readFileSync(LIST, 'utf8'));
}

if (process.argv[1] && import.meta.filename === process.argv[1] && process.argv.includes('--write')) {
  const now = await collect();
  let before: Record<Kind, string[]>;
  try { before = shipped(); } catch { before = { lessons: [], quizzes: [], missions: [], real: [] }; }
  const merged = Object.fromEntries((Object.keys(now) as Kind[]).map((k) => [k, [...new Set([...(before[k] ?? []), ...now[k]])].sort()]));
  writeFileSync(LIST, JSON.stringify(merged, null, 2) + '\n');
  for (const k of Object.keys(now) as Kind[]) console.log(`${k}: ${merged[k].length} (${merged[k].length - (before[k]?.length ?? 0)} new)`);
}
