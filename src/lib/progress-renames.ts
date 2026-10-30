// Progress is keyed by id: a lesson's path ("git/collaborate"), a quiz, mission
// or "Do it for real" id. Renaming one silently strands everyone who earned it -
// their XP stays, but the tick disappears and an Expedition containing it can
// never complete. tests/progress-ids.test.ts refuses to let a shipped id vanish
// unless it is listed here.
//
//  - RENAMED moves a learner's record to the new id the next time they load a page.
//  - RETIRED is for an id deliberately gone with nothing replacing it; the record
//    is left alone (it still counts toward XP, which was earned).

export type Kind = 'lessons' | 'quizzes' | 'missions' | 'real';

export const RENAMED: Record<Kind, Record<string, string>> = {
  lessons: {
    // 2026-10-30: merged into Build AI Agents. Its unique parts (the ReAct trace,
    // the shell-sandbox quiz, "the agent said it finished" is not evidence) moved
    // into what-is-an-agent and guardrails-and-evals; the rest duplicated them.
    'frontiers/agents': 'agents/what-is-an-agent',
  },
  quizzes: {},
  missions: {},
  real: {},
};

export const RETIRED: Record<Kind, string[]> = {
  lessons: [],
  // 2026-10-30, with frontiers/agents: each asked what an existing quiz asks
  // (agents-loop-3 on stopping, agents-tools-2 on injected instructions).
  quizzes: ['frontier-agents-1', 'frontier-agents-2'],
  missions: [],
  real: [],
};

/** Moves records from renamed ids to their new ones. Returns whether anything changed. */
export function migrate(p: Record<Kind, Record<string, string>>, renamed = RENAMED): boolean {
  let changed = false;
  for (const kind of Object.keys(renamed) as Kind[]) {
    for (const [from, to] of Object.entries(renamed[kind])) {
      if (!(from in p[kind])) continue;
      // If they somehow have both, keep the earlier timestamp: it is the true
      // date they earned it. XP is untouched either way - it was counted once.
      const at = p[kind][to];
      if (!at || p[kind][from] < at) p[kind][to] = p[kind][from];
      delete p[kind][from];
      changed = true;
    }
  }
  return changed;
}
