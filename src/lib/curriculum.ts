import { getCollection, type CollectionEntry } from 'astro:content';
import { TRACKS } from '../data/tracks.ts';

export type LessonEntry = CollectionEntry<'lessons'>;

/**
 * Joins the plan in tracks.ts to the MDX on disk and refuses to build when
 * they disagree. Both directions matter: a 'ready' lesson with no file would
 * link to a 404, and a file the plan does not list would be unreachable.
 */
export async function curriculum() {
  const entries = await getCollection('lessons');
  const byId = new Map(entries.map((e) => [e.id, e]));
  const problems: string[] = [];
  const planned = new Set<string>();
  const tracks = TRACKS.map((t) => ({
    ...t,
    lessons: t.lessons.map((l, i) => {
      const id = `${t.id}/${l.slug}`;
      planned.add(id);
      const entry = byId.get(id);
      if (l.status === 'ready' && !entry) problems.push(`${id} is marked ready but src/content/lessons/${id}.mdx does not exist`);
      if (l.status === 'soon' && entry) problems.push(`${id} has content but is marked soon - mark it ready or it stays hidden`);
      return { ...l, id, index: i, entry: l.status === 'ready' ? entry : undefined, href: `/learn/${id}/` };
    }),
  }));
  for (const e of entries) if (!planned.has(e.id)) problems.push(`${e.id}.mdx is not listed in src/data/tracks.ts`);
  if (problems.length) throw new Error(`Curriculum and content disagree:\n  - ${problems.join('\n  - ')}`);
  return tracks;
}

export function totals(tracks: Awaited<ReturnType<typeof curriculum>>) {
  const all = tracks.flatMap((t) => t.lessons);
  // Pages say "Nine tracks" in words. Counting here rather than writing the word
  // into the page means adding a track cannot leave the old number behind.
  const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];
  return { lessons: all.length, ready: all.filter((l) => l.status === 'ready').length, tracks: tracks.length, tracksWord: words[tracks.length] ?? String(tracks.length) };
}
