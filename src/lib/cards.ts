// Card decks: a situation, a few readings of it, one that the sources support.
// Each wrong option says why it is wrong, because "no" teaches less than "no,
// because". Every deck has to be passable only by reading the cards: a deck
// where the right answer is always in the same position, or where everything is
// broken, teaches pattern-matching instead (tests/agile.test.ts checks both).

import type { Mission } from './missions.ts';

export type Option = { id: string; text: string; why: string };
export type Card = { id: string; title: string; body: string; options: Option[]; answer: string; source: string };
export type Deck = { id: string; title: string; xp: number; cards: Card[]; debrief: string; licence?: string };
export type CardState = { deck: Deck; answers: Record<string, string> };

/** One step per card: done when that card's chosen reading is the supported one. */
export function deckMission(deck: Deck): Mission<CardState> {
  return {
    id: deck.id, title: deck.title, xp: deck.xp,
    setup: () => ({ deck, answers: {} }),
    steps: deck.cards.map((c) => ({ text: `${c.title}: what is going on?`, hint: 'Read the body, then pick the reading the sources support', done: (s: CardState) => s.answers[c.id] === c.answer })),
    debrief: deck.debrief,
  };
}
