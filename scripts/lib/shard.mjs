// Splits the browser check into equal parts that separate CI jobs run side by
// side. SHARD=2/3 means "the second of three parts". Unset means all of it,
// which is what `npm run check:site` on a desk does.
//
// The danger in any split is the part nobody runs: a typo that matches
// nothing, or a workflow that lists two jobs for a three-way split, and a
// third of the site goes unchecked under a green tick. So a malformed value
// is an error and not "run everything" or "run nothing", and the tests hold
// that every item belongs to exactly one part (tests/shard.test.ts). The
// workflow separately refuses a job list that does not match the split.

/**
 * @param {string | undefined} spec "i/n", 1-based, or undefined for everything
 * @returns {{ index: number, total: number, label: string, mine: (i: number) => boolean }}
 */
export function parseShard(spec) {
  if (spec === undefined || spec === '') return { index: 1, total: 1, label: 'all of it', mine: () => true };
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m) throw new Error(`SHARD must look like 2/3, not ${JSON.stringify(spec)}`);
  const index = Number(m[1]), total = Number(m[2]);
  if (total < 1 || index < 1 || index > total) throw new Error(`SHARD ${spec}: the part must be between 1 and ${total || 1}`);
  // Dealt out like cards, by position: neighbours in the list (one track's
  // lessons, one widget's scenarios) take about as long as each other, so
  // this spreads the slow ones instead of handing one job all of them.
  return { index, total, label: `part ${index} of ${total}`, mine: (i) => i % total === index - 1 };
}
