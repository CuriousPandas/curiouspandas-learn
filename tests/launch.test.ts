import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interview, isClean, HAVE_PROBLEM, STARTER, QUESTIONS, PEOPLE } from '../src/lib/launch/interview.ts';
import { evaluate, ROADMAP, FEATURES } from '../src/lib/launch/scope.ts';
import { economics, lowestPriceForPayback, lowestAnnualPrice, FACTS } from '../src/lib/launch/unit.ts';
import { launch, bestChannel, CHANNELS } from '../src/lib/launch/traction.ts';
import { INTERVIEW_MISSION, SCOPE_MISSION, PRICING_MISSION, TRACTION_MISSION } from '../src/lib/launch/missions.ts';

const doneSteps = <S>(m: { steps: { done: (s: S) => boolean }[] }, s: S) => m.steps.map((st) => st.done(s));

test('leading questions get a yes from everyone, including the four without the problem', () => {
  const r = interview(STARTER);
  assert.equal(r.saidYes, PEOPLE.length);
  assert.equal(r.bad, STARTER.length);
  assert.ok(r.rows.every((row) => row.learned.startsWith('nothing')));
});

test('questions about the past find exactly the two who act on the problem', () => {
  const r = interview(['last-time', 'today', 'spent']);
  assert.ok(isClean(r));
  const has = r.rows.filter((row) => row.learned.startsWith('has the problem')).map((row) => row.person.name);
  assert.deepEqual(has, ['Priya', 'Ken']);
  assert.equal(HAVE_PROBLEM, 2);
});

test('every person answers every question - no blank cells', () => {
  for (const p of PEOPLE) for (const q of QUESTIONS) assert.ok((p.answers[q.id] ?? p.polite[q.id])?.length, `${p.name} / ${q.id}`);
});

test('interview mission: counting the polite yeses does not pass, and a guess before evidence does not either', () => {
  const s = INTERVIEW_MISSION.setup();
  s.runs.push(interview(STARTER));
  s.decisions.push({ answer: 5, afterCleanSpend: false });
  assert.deepEqual(doneSteps(INTERVIEW_MISSION, s), [true, false, false, false]);
  // The right number, guessed before any clean interview, still does not count.
  s.decisions.push({ answer: 2, afterCleanSpend: false });
  assert.equal(INTERVIEW_MISSION.steps[3].done(s), false);
  s.runs.push(interview(['last-time', 'today', 'spent']));
  s.decisions.push({ answer: 2, afterCleanSpend: true });
  assert.deepEqual(doneSteps(INTERVIEW_MISSION, s), [true, true, true, true]);
});

test('scope: the roadmap is about ten weeks; dropping payment is fast and learns nothing about paying', () => {
  assert.equal(evaluate(ROADMAP).days, 48);
  const noPay = evaluate(['checker', 'email']);
  assert.ok(noPay.days <= 10 && !noPay.learns);
  assert.ok(evaluate(['billing', 'checker', 'email']).learns);
  const byHand = evaluate(['manual', 'text', 'paylink']);
  assert.ok(byHand.learns && byHand.days <= 3);
  assert.throws(() => evaluate(['nope']));
  assert.equal(FEATURES.filter((f) => f.byHand).length, 3);
});

test('scope mission: a fast plan without a way to ask for money leaves step two open', () => {
  const s = SCOPE_MISSION.setup();
  s.plans.push(evaluate(ROADMAP), evaluate(['checker', 'email']));
  assert.deepEqual(doneSteps(SCOPE_MISSION, s), [true, false, false]);
  s.plans.push(evaluate(['paylink', 'checker', 'email']), evaluate(['manual', 'text', 'paylink']));
  assert.deepEqual(doneSteps(SCOPE_MISSION, s), [true, true, true]);
});

test('unit economics match the a16z definitions: lifetime = 1/churn, LTV = margin x lifetime', () => {
  const r = economics(7);
  assert.equal(r.grossPerMonth, 5.5);
  assert.equal(r.lifetimeMonths, 20);
  assert.equal(r.ltv, 110);
  assert.ok(Math.abs(r.paybackMonths - FACTS.cac / 5.5) < 1e-9);
});

test('a $3 price never pays back; a price below cost loses money every month', () => {
  const cheap = economics(3);
  assert.equal(cheap.paysBack, false);
  assert.match(cheap.verdict, /^Never pays back/);
  assert.match(economics(1).verdict, /loses money every month/);
  assert.throws(() => economics(0));
});

test('the lowest prices: $7 monthly pays back within 12 months ($6 does not); $6 annual covers acquisition upfront', () => {
  assert.equal(lowestPriceForPayback(12), 7);
  assert.ok(economics(6).paybackMonths > 12);
  assert.equal(lowestAnnualPrice(), 6);
  assert.match(economics(6, 'annual').verdict, /covers acquisition on day one/);
  assert.match(economics(5, 'annual').verdict, /unpaid/);
});

test('annual billing uses the discounted price for profit, payback and LTV, not the sticker price', () => {
  // The first version showed $6 annual earning $4.50 a month with an LTV of $90:
  // the discount applied to the cash and nowhere else.
  const a = economics(6, 'annual');
  assert.equal(a.grossPerMonth, 3.5);
  assert.equal(a.ltv, 70);
  assert.ok(Math.abs(a.paybackMonths - 60 / 3.5) < 1e-9);
  assert.match(a.verdict, /only if they renew/);
});

test('pricing mission: any price that pays back is not the lowest one', () => {
  const s = PRICING_MISSION.setup();
  s.results.push(economics(3), economics(20));
  assert.deepEqual(doneSteps(PRICING_MISSION, s), [true, false, false]);
  s.results.push(economics(7), economics(10, 'annual'));
  assert.deepEqual(doneSteps(PRICING_MISSION, s), [true, true, false]);
  s.results.push(economics(6, 'annual'));
  assert.deepEqual(doneSteps(PRICING_MISSION, s), [true, true, true]);
});

test('the big launch wins sign-ups and loses on users still active in week four', () => {
  const big = launch('big-launch', 'self'), forum = launch('forum', 'self');
  assert.ok(big.signups > forum.signups * 5);
  assert.ok(forum.retained > big.retained);
  assert.ok(launch('forum', 'by-hand').activated > forum.activated);
  assert.equal(bestChannel(), 'forum');
  assert.equal(Object.keys(CHANNELS).length, 3);
});

test('traction mission: choosing the channel with the most sign-ups does not pass', () => {
  const s = TRACTION_MISSION.setup();
  s.launches.push(launch('big-launch', 'self'), launch('forum', 'self'), launch('forum', 'by-hand'));
  s.chosen = 'big-launch';
  assert.deepEqual(doneSteps(TRACTION_MISSION, s), [true, true, true, false]);
  s.chosen = 'forum';
  assert.equal(TRACTION_MISSION.steps[3].done(s), true);
});
