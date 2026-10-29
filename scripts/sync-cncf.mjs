// Reads the CNCF's own landscape data and records, for every atlas tool, whether
// it is a CNCF project and at what maturity. Run it, read the diff, commit the
// snapshot: maturity changes (sandbox -> incubating -> graduated) then show up
// as a reviewable change with a date, never as a fact remembered wrong.
//
//   npm run sync:cncf
//
// Fails loudly when the fetch or parse fails rather than writing an empty
// snapshot, which would render every tool as "not CNCF".

import { parse } from 'yaml';
import { writeFileSync, readFileSync } from 'node:fs';

const SOURCE = 'https://raw.githubusercontent.com/cncf/landscape/master/landscape.yml';
const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`landscape fetch failed: ${res.status} ${res.statusText}`);
const doc = parse(await res.text());
const items = [];
for (const cat of doc.landscape ?? []) for (const sub of cat.subcategories ?? []) for (const it of sub.items ?? []) {
  items.push({ name: it.item?.name ?? it.name, project: it.item?.project ?? it.project, homepage: it.item?.homepage_url ?? it.homepage_url, category: cat.name, subcategory: sub.name });
}
if (items.length < 500) throw new Error(`landscape parsed to only ${items.length} items - the format probably changed; refusing to write`);

// tools.ts is TypeScript; Node strips the types, so import it directly.
const { TOOLS } = await import('../src/data/tools.ts');
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const out = {};
for (const t of TOOLS) {
  const want = norm(t.landscape ?? t.name);
  const hits = items.filter((i) => norm(i.name) === want);
  const cncf = hits.find((h) => h.project);
  const hit = cncf ?? hits[0];
  out[t.id] = hit
    ? { landscapeName: hit.name, maturity: hit.project ?? null, homepage: hit.homepage ?? null, landscapeCategory: `${hit.category} / ${hit.subcategory}` }
    : { landscapeName: null, maturity: null, homepage: null, landscapeCategory: null };
}

const prev = (() => { try { return JSON.parse(readFileSync('src/data/cncf-snapshot.json', 'utf8')).tools; } catch { return {}; } })();
const snapshot = { source: SOURCE, fetchedAt: new Date().toISOString().slice(0, 10), items: items.length, tools: out };
writeFileSync('src/data/cncf-snapshot.json', JSON.stringify(snapshot, null, 2) + '\n');

console.log(`landscape items: ${items.length}`);
for (const [id, v] of Object.entries(out)) {
  const before = prev[id]?.maturity;
  const mark = before !== undefined && before !== v.maturity ? `   (was ${before})` : '';
  console.log(`${id.padEnd(18)} ${String(v.maturity ?? (v.landscapeName ? 'in landscape, not CNCF' : 'NOT FOUND')).padEnd(24)} ${v.landscapeName ?? ''}${mark}`);
}
