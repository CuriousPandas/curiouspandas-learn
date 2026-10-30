// Customer interviews for one idea: an app that tells small online shops when
// their site goes down. Five shop owners, scripted. Questions about the idea,
// opinions or the future get the same polite yes from everyone; questions
// about what already happened get the truth, which differs person to person.
// Only two of the five have the problem badly enough to act on it today.

export type Kind = 'pitch' | 'opinion' | 'future' | 'leading' | 'past' | 'workaround' | 'spend' | 'cost';
export type Question = { id: string; text: string; kind: Kind };

// Asking about your idea, their opinion or what they would do one day invites
// a kind answer, not a true one.
export const BAD_KINDS: readonly Kind[] = ['pitch', 'opinion', 'future', 'leading'];
export const isBad = (q: Question) => BAD_KINDS.includes(q.kind);

export const QUESTIONS: Question[] = [
  { id: 'would-use', text: 'Would you use an app that texts you when your shop goes down?', kind: 'pitch' },
  { id: 'good-idea', text: 'Do you think this is a good idea?', kind: 'opinion' },
  { id: 'would-pay', text: 'How much would you pay for it each month?', kind: 'future' },
  { id: 'wouldnt-it', text: "Wouldn't it be great to never miss an outage?", kind: 'leading' },
  { id: 'last-time', text: 'When did your site last go down? What happened?', kind: 'past' },
  { id: 'how-know', text: 'How did you find out it was down?', kind: 'past' },
  { id: 'today', text: 'What do you do today to check the site is up?', kind: 'workaround' },
  { id: 'spent', text: 'Have you spent money or time on this? On what?', kind: 'spend' },
  { id: 'cost', text: 'What did the last outage cost you?', kind: 'cost' },
];

export const STARTER = ['would-use', 'good-idea', 'would-pay', 'wouldnt-it'];

type Has = 'strong' | 'mild' | 'none';
export type Person = { name: string; shop: string; has: Has; answers: Record<string, string>; polite: Record<string, string> };

const polite = (yes: string, pay: string): Record<string, string> => ({
  'would-use': yes,
  'good-idea': 'Definitely. I would tell other shop owners about it.',
  'would-pay': pay,
  'wouldnt-it': 'Of course - who would not want that?',
});

export const PEOPLE: Person[] = [
  {
    name: 'Priya', shop: 'handmade soap', has: 'strong',
    polite: polite('Yes, that sounds really useful!', 'Maybe $10 a month? Sure.'),
    answers: {
      'last-time': 'Black Friday weekend. About six hours.',
      'how-know': 'A customer emailed to ask why checkout was broken.',
      today: 'I pay for a monitoring service, but its alerts go to an inbox I never read.',
      spent: 'Yes - $15 a month for that service, and an evening setting it up.',
      cost: 'Most of a weekend of orders. I spent days refunding and apologising.',
    },
  },
  {
    name: 'Ken', shop: 'vintage cameras', has: 'mild',
    polite: polite('Oh, nice. I would probably use that.', 'I guess $5 or so.'),
    answers: {
      'last-time': 'A couple of months ago, I think. An hour or two?',
      'how-know': 'I check it every morning with my coffee, so that morning.',
      today: 'I open the shop page every morning before work.',
      spent: 'Only my time - a few minutes every single day.',
      cost: 'Not sure. A few orders, probably.',
    },
  },
  {
    name: 'Ana', shop: 'art prints', has: 'none',
    polite: polite('Yes! Great idea.', 'Maybe $10?'),
    answers: {
      'last-time': 'I cannot remember it ever going down. The platform looks after that.',
      'how-know': 'It has not happened, as far as I know.',
      today: 'Nothing. The platform emails a status update if anything breaks.',
      spent: 'No.',
      cost: 'Nothing I know of.',
    },
  },
  {
    name: 'Tom', shop: 'a weekend side project', has: 'none',
    polite: polite('Sure, sounds handy.', 'A few dollars, I suppose.'),
    answers: {
      'last-time': 'Never, I think - though I am not sure I would notice.',
      'how-know': 'Honestly, I would not.',
      today: 'Nothing.',
      spent: 'No. It is a side thing - a few sales a month.',
      cost: 'A sale or two at most.',
    },
  },
  {
    name: 'Lin', shop: 'loose-leaf tea', has: 'none',
    polite: polite('That would be brilliant.', 'I could do $8.'),
    answers: {
      'last-time': 'Once, when I forgot to renew the domain.',
      'how-know': 'The renewal reminder email. I fixed it the same day.',
      today: 'I turned on auto-renew after that, so nothing.',
      spent: 'No - auto-renew was free.',
      cost: 'Half a day of orders, once.',
    },
  },
];

/** Of the five, how many have the problem today, enough to already spend money or time on it. */
export const HAVE_PROBLEM = PEOPLE.filter((p) => p.has !== 'none').length;

export type Answer = { q: Question; text: string; signal: 'compliment' | 'promise' | 'fact' };
export type Row = { person: Person; answers: Answer[]; liked: boolean; learned: string };
export type Run = { asked: string[]; bad: number; kinds: Kind[]; rows: Row[]; saidYes: number };

export function interview(asked: string[]): Run {
  const qs = asked.map((id) => {
    const q = QUESTIONS.find((x) => x.id === id);
    if (!q) throw new Error(`no question ${id}`);
    return q;
  });
  const rows = PEOPLE.map((person) => {
    const answers: Answer[] = qs.map((q) => isBad(q)
      ? { q, text: person.polite[q.id], signal: q.kind === 'future' ? 'promise' : 'compliment' }
      : { q, text: person.answers[q.id], signal: 'fact' });
    const facts = answers.filter((a) => a.signal === 'fact');
    // What a careful listener can conclude from the facts alone.
    const learned = !facts.length ? 'nothing you can rely on - only opinions'
      : person.has === 'strong' && qs.some((q) => q.kind === 'spend' || q.kind === 'workaround') ? 'has the problem: already pays for a workaround'
      : person.has === 'mild' && qs.some((q) => q.kind === 'spend' || q.kind === 'workaround') ? 'has the problem: works around it by hand every day'
      : person.has === 'none' ? 'no sign of the problem today'
      : 'had an outage - ask what they do about it now';
    return { person, answers, liked: answers.some((a) => a.signal !== 'fact'), learned };
  });
  return { asked, bad: qs.filter(isBad).length, kinds: qs.map((q) => q.kind), rows, saidYes: rows.filter((r) => r.liked).length };
}

/** A script worth trusting: at least three questions, none about the idea, opinions or the future. */
export const isClean = (r: Run) => r.bad === 0 && r.asked.length >= 3;
