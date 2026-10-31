// Every card deck on the site, by id, for <CardSort mission="...">. A deck
// missing from here makes CardSort refuse to build rather than render empty.

import type { Deck } from './cards.ts';
import { IN_NAME_ONLY, SCRUM_EVENTS } from './agile/cards.ts';
import { ONE_WAY_DOORS, GOLDEN_MASTER, FLAG_DEBT, API_CHANGES } from './change/cards.ts';

export const DECKS: Record<string, Deck> = Object.fromEntries(
  [IN_NAME_ONLY, SCRUM_EVENTS, ONE_WAY_DOORS, GOLDEN_MASTER, FLAG_DEBT, API_CHANGES].map((d) => [d.id, d]),
);
