// Loki: whether a missing or empty log result means Loki refused the lines, a
// query matched the wrong label, or all is well. Cards are from the sources in
// src/content/lessons/tools/loki.mdx; any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const LOKI_DECK: Deck = {
  id: 'tool-loki', title: 'Did Loki keep that line?', xp: 40,
  cards: [
    {
      id: 'skew', title: 'Two hosts, one stream',
      body: 'A nightly job runs on two hosts that share one set of labels. One host\'s clock is 90 minutes behind. Its lines show up in kubectl logs but never in Loki, and loki_discarded_samples_total{reason="too_far_behind"} keeps climbing.',
      options: [
        { id: 'a', text: 'Alloy will retry the batch later, so the lines will appear once the clocks agree', why: 'too_far_behind is not retryable and the sample is discarded. Alloy never retries a 4xx other than 429.' },
        { id: 'b', text: 'Loki is refusing them: they fall more than an hour behind the newest line in the shared stream', why: 'Supported. With unordered writes, lines older than half of max_chunk_age (1 hour by default) behind the newest entry are rejected. Loki\'s docs add that splitting streams helps, especially when several hosts send to one stream.' },
        { id: 'c', text: 'The job is not logging; kubectl logs must be showing a cached copy', why: 'kubectl logs reads what the container wrote. The counter shows Loki receiving the lines and discarding them.' },
      ],
      answer: 'b', source: 'Loki docs: request validation and troubleshoot ingestion (too_far_behind); Alloy docs: loki.write (v1.19)',
    },
    {
      id: 'shuffle', title: 'Twenty minutes out of order',
      body: 'After a network blip, a collector delivers a burst of lines up to 20 minutes older than lines already stored for the same stream. Every one of them appears in Loki, in timestamp order, and the discarded counter does not move.',
      options: [
        { id: 'a', text: 'Working as intended: since 2.4 Loki accepts out-of-order lines within an hour of the newest entry', why: 'Supported. unordered_writes defaults to true, and the acceptable window is half of max_chunk_age, which defaults to 2 hours. Twenty minutes is well inside it.' },
        { id: 'b', text: 'A bug: Loki should have rejected anything older than the newest line', why: 'That was the rule with unordered_writes set to false, before 2.4 made unordered writes the default.' },
        { id: 'c', text: 'The lines were silently re-stamped with the time they arrived', why: 'Nothing here suggests re-stamping; the lines kept their timestamps and were sorted by them.' },
      ],
      answer: 'a', source: 'Loki docs: troubleshoot ingestion, out_of_order and too_far_behind (v3.6.x)',
    },
    {
      id: 'extracted', title: 'The filter that matched nothing',
      body: 'A stream has the label app="checkout". Its lines are JSON with a field "app":"payments-lib". The query {app="checkout"} | json | app="payments-lib" returns nothing, even though the field is in every line.',
      options: [
        { id: 'a', text: 'The json parser failed, so every line was filtered out with an error', why: 'A parse failure does not filter the line out; Loki adds an __error__ label to it instead. And these lines are valid JSON.' },
        { id: 'b', text: 'Loki does not index log content, so JSON fields can never be filtered', why: 'Parsers exist exactly for this: they extract fields at query time so you can filter on them.' },
        { id: 'c', text: 'The extracted field was renamed app_extracted, because the stream already has a label called app', why: 'Supported. When an extracted key already exists as a stream label, Loki suffixes it with _extracted, so app="payments-lib" tested the stream label, which is checkout.' },
      ],
      answer: 'c', source: 'Loki docs: log queries, parser expressions (v3.6.x)',
    },
  ],
  debrief: 'An empty Loki result has more than one meaning. Loki may have refused the lines, and its tables say which refusals are final; a query may be testing a different label from the one you meant; or the system may simply be fine. The discarded counter and the parser rules tell these apart, and the app\'s own output never will.',
};

export const LOKI_DECK_MISSION = deckMission(LOKI_DECK);
