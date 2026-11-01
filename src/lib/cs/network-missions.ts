// The Network Lab's two missions. Each step reads what the lab actually ran, so
// a learner can't pass by reading the lesson, and the shortcuts that look like
// success (restarting everything, emptying the network) don't count. Played,
// shortcuts included, in tests/network.test.ts.

import type { Mission } from '../missions.ts';
import { NetworkLab, type RouteRun } from './network.ts';

export type NetState = { lab: NetworkLab };
const setup = (): NetState => ({ lab: new NetworkLab() });

const sameKeys = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const sameDist = (a: RouteRun, b: RouteRun) => JSON.stringify(Object.entries(a.dist ?? {}).sort()) === JSON.stringify(Object.entries(b.dist ?? {}).sort());

export const NETWORK_GRAPHS_MISSION: Mission<NetState> = {
  id: 'alg-graphs-network', title: 'The update that would not die', xp: 70, setup,
  steps: [
    { text: 'Flood tab: put out 8, 40, 44 and run at least 100 ticks. Nothing is generating new updates, so does it stop?', hint: 'Inject, then Run 100 ticks', done: (s) => s.lab.sawFloodPersist },
    { text: 'Restart one IMP while the flood is live, run on, and watch what happens to it', hint: 'Restart this IMP, then Run 10 ticks', done: (s) => s.lab.sawReinfection },
    { text: 'Reset, switch to Rosen\'s < fix, inject the same three numbers and let them die out by themselves', hint: 'Reset, tick the fix, Inject, Run 100 ticks', done: (s) => s.lab.sawFixEndIt },
    { text: 'Now break the fix: with it still on, inject the invented 0, 20, 40 and run 100 ticks', hint: 'Reset, keep the fix on, pick 0, 20, 40, Inject, Run 100 ticks', done: (s) => s.lab.sawFixBroken },
    { text: 'Route tab: run breadth-first and depth-first from the same start. Different orders, same places reached', hint: 'Choose each algorithm in turn and press Run to the end', done: (s) => {
      const r = s.lab.routes.filter((x) => x.graph === 'map');
      return r.some((a) => a.algo === 'bfs' && r.some((b) => b.algo === 'dfs' && b.start === a.start && a.order!.join() !== b.order!.join() && sameKeys(a.order!, b.order!)));
    } },
    { text: 'Build tab: add the edge that makes a cycle, then build it both ways: refused, and built anyway after one line of warning', hint: 'Tick the extra edge, then Build with each mode', done: (s) => s.lab.builds.some((b) => b.cycle && b.mode === 'raise' && !!b.result.cycle) && s.lab.builds.some((b) => b.cycle && b.mode === 'drop' && b.result.dropped.length > 0) },
  ],
  debrief: '"Later than" looked like an order and wasn\'t: it had a cycle in it, so three updates each beat the last one forever. A restarted IMP just caught the same updates again from its neighbours, which is why restarting one did nothing. The first guess, a malformed update, was on the right track but not quite correct, in Rosen\'s words: the routing code was working, and what had been corrupted was a sequence number. A graph with a cycle has no first thing, and a tool can tell you so (graphlib refuses) or carry on without one of your dependencies (make\'s source drops it). And Rosen was right not to promise more: his fix stops every chain of dropped bits, but the rule still has cycles in it, as you just showed.',
};

export const NETWORK_PATHS_MISSION: Mission<NetState> = {
  id: 'alg-paths-negative', title: 'Did anything tell you?', xp: 60, setup,
  steps: [
    { text: 'With every length positive, run Dijkstra and Bellman-Ford from s. They should agree', hint: 'Choose each algorithm and press Run to the end', done: (s) => {
      const r = s.lab.routes.filter((x) => x.graph === 'negative' && !x.hasNegative);
      return r.some((a) => a.algo === 'dijkstra' && r.some((b) => b.algo === 'bellman-ford' && b.weights === a.weights && b.start === a.start && sameDist(a, b)));
    } },
    { text: 'Change the length of b to a to -2 and run Dijkstra again. Look for an error message', hint: 'Set b to a to -2, then Run to the end', done: (s) => s.lab.routes.some((x) => x.graph === 'negative' && x.hasNegative && x.algo === 'dijkstra') },
    { text: 'Run Bellman-Ford on the same lengths. Which answer is right, and did the wrong one warn you?', hint: 'Choose Bellman-Ford and press Run to the end', done: (s) => {
      const r = s.lab.routes.filter((x) => x.graph === 'negative' && x.hasNegative);
      return r.some((a) => a.algo === 'dijkstra' && r.some((b) => b.algo === 'bellman-ford' && b.weights === a.weights && b.start === a.start && !sameDist(a, b)));
    } },
  ],
  debrief: 'With b to a at -2, the textbook form gives t a length of 3, printed with the same confidence as any other answer, and it is wrong: s to b to a to t is 2. Nothing failed. It settled a at distance 2 and never looked at it again, which is fine only if no later edge can make a path shorter. That is the assumption hiding in "in order of increasing length". A check you can run against a different algorithm is what found it.',
};
