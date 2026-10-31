// Flagger: whether a learner can tell a promotion that skipped its checks, a
// normal warm-up, and a query that matches nothing. Cards are from the sources in
// src/content/lessons/tools/flagger.mdx; any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const FLAGGER_DECK: Deck = {
  id: 'tool-flagger', title: 'Did Flagger actually check this release?', xp: 40,
  cards: [
    {
      id: 'skip-left-on', title: 'Succeeded in one step',
      body: 'A release that fails 6% of requests went to 100% of users. The Canary says Succeeded. Its events show no weight steps, just "Promotion completed! Canary analysis was skipped for hello.hello".',
      options: [
        { id: 'a', text: 'The analysis ran and the 6% was inside the threshold', why: 'There was no analysis to pass. The event says it was skipped, and no weight steps were recorded.' },
        { id: 'b', text: 'skipAnalysis is set: Flagger promoted on readiness alone', why: 'Supported. Flagger docs: with skip analysis enabled it checks the canary deployment is healthy and promotes it without analysing it.' },
        { id: 'c', text: 'Prometheus was down, so Flagger defaulted to promoting', why: 'Flagger does not promote on missing data: a metric with no values halts advancement and counts as a failed check.' },
      ],
      answer: 'b', source: 'Flagger docs - Deployment strategies; Flagger source v1.45.0 scheduler.go',
    },
    {
      id: 'warm-up', title: 'No values, twice',
      body: 'On a fresh lab 06, the first analysis rounds log "Halt advancement no values found for custom metric: ambient-success-rate". About two minutes later the same release promotes.',
      options: [
        { id: 'a', text: 'Normal: there was no rate yet, so Flagger waited; it only matters if it never stops', why: 'Supported. Tilt\'s lab 06 README records exactly this on a fresh cluster, and the release promoted 102 seconds later.' },
        { id: 'b', text: 'A bad version that recovered by luck', why: 'The version was never judged bad. No values halts advancement until a rate exists; it does not mean errors.' },
        { id: 'c', text: 'Flagger ignored the metric and promoted anyway', why: 'It did not ignore it: it halted on no values, and promoted only after the metric had values that passed.' },
      ],
      answer: 'a', source: 'TemplateMechanics/tilt labs/06-canary/README.md; Flagger source v1.45.0 scheduler_metrics.go',
    },
    {
      id: 'query-matches-nothing', title: 'Every release rolls back',
      body: 'Every release rolls back. The events say no values found for the success-rate metric, "probably hello.hello is not receiving traffic". The load tester is running and hello.localhost serves fine.',
      options: [
        { id: 'a', text: 'Every new version is genuinely bad', why: 'Unlikely to be true of every version, and the events say no values, not a low success rate.' },
        { id: 'b', text: 'Flagger is broken and needs reinstalling', why: 'Flagger is doing what it should with no data: halting and counting failed checks until the threshold.' },
        { id: 'c', text: 'The query matches no series, for example a label the mesh never emits; run it in Prometheus', why: 'Supported. Tilt found exactly this: the built-in metric asks for reporter="destination", which ambient mode never emits.' },
      ],
      answer: 'c', source: 'TemplateMechanics/tilt labs/06-canary/metric-template.yaml; Flagger docs - Webhooks',
    },
  ],
  debrief: 'Flagger treats missing data as a failure, so a broken query is noisy: it rolls back. The quiet case is the one where it was told not to look. A skipped promotion ends in Succeeded like any other, and only the events and the spec show the difference.',
};

export const FLAGGER_DECK_MISSION = deckMission(FLAGGER_DECK);
