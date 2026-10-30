// Missions for the Idea to Market track, in the shape of src/lib/missions.ts.
// Each checks what the learner did, and the tempting answer leaves its step
// open: counting the polite yeses, cutting the payment step to hit a deadline,
// any price that "pays back" rather than the lowest, the launch with the most
// sign-ups.

import type { Mission } from '../missions.ts';
import { HAVE_PROBLEM, isClean, type Run } from './interview.ts';
import { ROADMAP, type Plan } from './scope.ts';
import { lowestAnnualPrice, lowestPriceForPayback, type Result } from './unit.ts';
import { bestChannel, type Channel, type Launch } from './traction.ts';

// ---- validate ---------------------------------------------------------------

export type InterviewState = { runs: Run[]; decisions: { answer: number; afterCleanSpend: boolean }[] };
const cleanSpend = (s: InterviewState) => s.runs.some((r) => isClean(r) && r.kinds.includes('spend'));

export const INTERVIEW_MISSION: Mission<InterviewState> = {
  id: 'launch-interview', title: 'Evidence, not compliments', xp: 50,
  setup: () => ({ runs: [], decisions: [] }),
  steps: [
    { text: 'Interview all five with the starter script', hint: 'Press "Interview all five" without changing the questions', done: (s) => s.runs.some((r) => r.bad >= 3) },
    { text: 'Rewrite the script so no question is about your idea, their opinion or the future - then run it', hint: 'Untick every question that mentions the app, asks if it is good, or asks what they would do. Pick three about what already happened', done: (s) => s.runs.some(isClean) },
    { text: 'Include a question about money or time they have already spent', hint: '"Have you spent money or time on this?" - spending is the strongest evidence a problem is real', done: cleanSpend },
    { text: 'Decide: how many of the five have this problem today?', hint: 'Count the people whose answers show they already pay or work around it - not the people who said yes', done: (s) => s.decisions.some((d) => d.afterCleanSpend && d.answer === HAVE_PROBLEM) },
  ],
  debrief: 'All five said yes to the pitch, and four of them have no problem to solve: kindness is not demand. Asking about the last outage, what they do today and what they have spent turned five compliments into two real problems - one person already paying for a workaround, one losing minutes every morning. Two is a smaller number, and it is the one you can build on.',
};

// ---- mvp ----------------------------------------------------------------------

export type ScopeState = { plans: Plan[] };

export const SCOPE_MISSION: Mission<ScopeState> = {
  id: 'launch-scope', title: 'Test the risk, not the roadmap', xp: 50,
  setup: () => ({ plans: [] }),
  steps: [
    { text: 'Check the full roadmap: how long before you learn anything?', hint: 'Press "Full roadmap", then "Check this plan"', done: (s) => s.plans.some((p) => ROADMAP.every((id) => p.picked.includes(id))) },
    { text: 'Cut it to two weeks (10 working days or less) - and still test whether owners will pay', hint: 'A plan that drops payment entirely ships fast and cannot answer the question. Keep one way to ask for money', done: (s) => s.plans.some((p) => p.days <= 10 && p.learns) },
    { text: 'Do the unscalable version: test the same assumption in 3 days or less', hint: 'Swap automation for things you do by hand: run the checks yourself, text the owner, send a payment link', done: (s) => s.plans.some((p) => p.days <= 3 && p.learns) },
  ],
  debrief: 'The roadmap took ten weeks and every feature in it could be built - none of that was the risk. The risk was whether anyone pays to hear about outages, and three things test it: notice, tell, ask for money. Doing two of them by hand gets the answer in a day. If it is yes, you have customers waiting while you automate; if it is no, you saved ten weeks.',
};

// ---- pricing --------------------------------------------------------------------

export type PricingState = { results: Result[] };

export const PRICING_MISSION: Mission<PricingState> = {
  id: 'launch-pricing', title: 'A price that pays back', xp: 50,
  setup: () => ({ results: [] }),
  steps: [
    { text: 'Try the "undercut everyone" price of $3 a month and read the verdict', hint: 'Press "$3 - undercut everyone"', done: (s) => s.results.some((r) => r.billing === 'monthly' && r.price <= 3 && !r.paysBack) },
    { text: 'Find the lowest whole-dollar monthly price that earns back the $60 it cost to win a customer within 12 months', hint: 'Payback = $60 / (price - $1.50). Any higher price also passes - the step wants the lowest', done: (s) => s.results.some((r) => r.billing === 'monthly' && r.price === lowestPriceForPayback(12)) },
    { text: 'Switch to annual billing (a year for the price of 10 months). Find the lowest price whose upfront payment covers acquisition on day one', hint: 'Upfront = 10 x price. It must reach $60', done: (s) => s.results.some((r) => r.billing === 'annual' && r.price === lowestAnnualPrice()) },
  ],
  debrief: 'At $3 every customer earns $1.50 a month and costs $60 to win, so they leave - on average after 20 months - long before paying it back: more customers, more loss. $7 pays back inside a year. Annual billing moves the cash forward: at $6 a month, one upfront payment covers what it cost to win the customer. The formulas are general; the $60, $1.50 and 5% are this toy\'s - measure your own.',
};

// ---- first users ------------------------------------------------------------------

export type TractionState = { launches: Launch[]; chosen?: Channel };

export const TRACTION_MISSION: Mission<TractionState> = {
  id: 'launch-traction', title: 'Still here in week four', xp: 50,
  setup: () => ({ launches: [] }),
  steps: [
    { text: 'Launch on the big tech news site and compare sign-ups with users still active in week four', hint: 'Channel: big launch, then Launch', done: (s) => s.launches.some((l) => l.channel === 'big-launch') },
    { text: 'Launch where your users already are', hint: 'Shop owners already ask about outages in their own forum', done: (s) => s.launches.some((l) => l.channel === 'forum') },
    { text: 'Do something that does not scale: set up every new user\'s first check with them', hint: 'Tick "set up their first check with them", then Launch again', done: (s) => s.launches.some((l) => l.onboarding === 'by-hand') },
    { text: 'Choose the channel to put next month into - judged by users still active in week four, not sign-ups', hint: 'The most sign-ups is the tempting answer. Look at the last column', done: (s) => s.chosen === bestChannel() && s.launches.some((l) => l.channel === bestChannel()) },
  ],
  debrief: 'The big launch won sign-ups by a mile and lost where it counts: most of those visitors were not shop owners with outages, so few set anything up and fewer stayed. The forum sent a trickle of people who had the problem, and setting up their first check by hand doubled how many got going. Thirty minutes each is unaffordable at 400 sign-ups and is exactly right at 45 - which is the point of doing things that do not scale while you still can.',
};
