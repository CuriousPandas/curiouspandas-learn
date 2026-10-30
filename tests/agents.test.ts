import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fit, tokensOf } from '../src/lib/agents/sim.ts';
import { invoiceAgent, supportAgent, supportTools, type SupportConfig } from '../src/lib/agents/scenarios.ts';
import { runDesign, TICKETS } from '../src/lib/agents/workflows.ts';
import { runEval, CASES } from '../src/lib/agents/evals.ts';
import { JOBS, check, type Autonomy } from '../src/lib/agents/business.ts';
import { LOOP_MISSION, TOOLS_MISSION, FLOW_MISSION, EVAL_MISSION, DESIGN_MISSION } from '../src/lib/agents/missions.ts';

const done = <S,>(m: { steps: { done: (s: S) => boolean }[] }, s: S) => m.steps.map((st) => st.done(s));

test('the loop answers in three model calls, and the context grows every call', () => {
  const a = invoiceAgent({ maxSteps: 8 });
  a.run();
  assert.equal(a.status, 'answered');
  assert.equal(a.calls, 3);
  assert.match(a.events.at(-1)!.kind === 'answer' ? (a.events.at(-1) as { text: string }).text : '', /18 days overdue/);
  for (let i = 1; i < a.contextAtCall.length; i++) assert.ok(a.contextAtCall[i] > a.contextAtCall[i - 1]);
  assert.equal(a.inputTokens, a.contextAtCall.reduce((x, y) => x + y, 0));
  assert.ok(!a.ran('send_email'), 'the email tool it does not need is never used');
});

test('the step limit, not the model, stops a run', () => {
  const a = invoiceAgent({ maxSteps: 2 });
  a.run();
  assert.equal(a.status, 'stopped');
  assert.equal(a.calls, 2);
});

test('with no tool for a piece of the task, the agent says so instead of guessing', () => {
  const a = invoiceAgent({ maxSteps: 8, tools: ['find_invoice', 'send_email'] });
  a.run();
  assert.equal(a.status, 'answered');
  assert.deepEqual(a.gaveUpOn, ['the number of days']);
  assert.doesNotMatch((a.events.at(-1) as { text: string }).text, /18/);
});

test('tools are chosen by description: "Gets data." loses to whatever sounds closer', () => {
  const words = ['order', 'number', 'status', 'tracking'];
  const vague = supportTools('vague', true), precise = supportTools('precise', true);
  assert.equal(fit(vague.find((t) => t.name === 'get_order')!, words), 0);
  assert.equal(fit(precise.find((t) => t.name === 'get_order')!, words), 4);
  // The vague run picks the refund tool - "Give an order number" - and refunds the order it was asked to find.
  const a = supportAgent({ email: 'normal', desc: 'vague', refundTool: true, rule: false, gate: false });
  a.run();
  assert.ok(a.ran('issue_refund'));
  assert.ok(a.world.refunded.has('881'));
  assert.ok(!a.world.sent.some((m) => m.includes('track.example')));
});

const cfg = (c: Partial<SupportConfig>): SupportConfig => ({ email: 'disguised', desc: 'precise', refundTool: true, rule: false, gate: false, ...c });

test('the prompt rule stops the obvious injection and not the disguised one', () => {
  const plain = supportAgent(cfg({ email: 'plain', rule: true })); plain.run();
  assert.equal(plain.world.refunded.size, 0);
  const disguised = supportAgent(cfg({ rule: true })); disguised.run();
  assert.equal(disguised.world.refunded.size, 37, 'asking nicely did not hold');
});

test('taking the refund tool away stops the injection, and Maya still gets her answer', () => {
  const a = supportAgent(cfg({ refundTool: false })); a.run();
  assert.equal(a.world.refunded.size, 0);
  assert.ok(a.world.sent.some((m) => m.includes('track.example')));
  assert.ok(!a.events.some((e) => e.kind === 'call' && e.tool === 'get_order' && e.arg.startsWith('all')), 'a lookup tool is not repurposed for the injected order');
});

test('an approval gate pauses before every write; denying the refund still lets the reply go', () => {
  const a = supportAgent(cfg({ gate: true })); a.run();
  assert.equal(a.status, 'awaiting');
  assert.equal(a.awaiting!.tool.name, 'issue_refund');
  a.decide(false); a.run();
  assert.equal(a.awaiting!.tool.name, 'send_reply');
  a.decide(true); a.run();
  assert.equal(a.status, 'answered');
  assert.equal(a.world.refunded.size, 0);
  assert.equal(a.world.sent.length, 1);
});

test('tokens: about four characters each', () => {
  assert.equal(tokensOf('abcd'), 1);
  assert.equal(tokensOf('abcde'), 2);
});

test('workflow is cheap but misses the odd tickets; the agent handles all at a much higher cost; hybrid handles all for less', () => {
  const w = runDesign('workflow'), a = runDesign('agent'), h = runDesign('hybrid');
  const odd = TICKETS.filter((t) => t.kind === 'odd').length;
  assert.equal(w.handled, 20 - odd);
  assert.equal(a.handled, 20);
  assert.equal(h.handled, 20);
  assert.ok(w.cost < h.cost && h.cost < a.cost, `${w.cost} < ${h.cost} < ${a.cost}`);
  assert.ok(a.cost > 1.5 * h.cost, 'the agent-everywhere design costs well over the hybrid');
  assert.ok(a.cost > 4 * w.cost, 'and over four times the plain workflow');
  assert.equal(w.slowest, 2);
  assert.ok(a.slowest >= 6);
  // Hybrid does not fix the worst case: an odd ticket still pays for the agent, plus the classifier.
  assert.equal(h.slowest, a.slowest + 1);
});

test('eval: the demo passes everywhere; only v2 plus the code guardrail passes all eight', () => {
  for (const prompt of ['v1', 'v2'] as const) for (const guardrail of [false, true]) {
    assert.ok(runEval({ prompt, guardrail }, 'demo').every((r) => r.pass), `demo on ${prompt}/${guardrail}`);
  }
  const score = (prompt: 'v1' | 'v2', guardrail: boolean) => runEval({ prompt, guardrail }, 'all').filter((r) => r.pass).length;
  assert.equal(CASES.length, 8);
  assert.equal(score('v1', false), 6);
  assert.equal(score('v1', true), 6, 'going back to v1 cannot pass all eight');
  assert.equal(score('v2', false), 6);
  assert.equal(score('v2', true), 8);
  const fails = runEval({ prompt: 'v2', guardrail: false }, 'all').filter((r) => !r.pass).map((r) => r.id);
  assert.deepEqual(fails, ['big-refund', 'injection']);
});

const invoices = JOBS.find((j) => j.id === 'invoices')!;
const all = (v: Autonomy) => Object.fromEntries(invoices.actions.map((a) => [a.id, v]));
const sensible: Record<string, Autonomy> = { read: 'alone', draft: 'alone', note: 'alone', send: 'approve', fee: 'approve', pause: 'never' };

test('business design: all-alone fails risk, all-approve fails usefulness, the sensible design passes both', () => {
  const alone = check(invoices, all('alone'), 'sonnet', 200);
  assert.ok(!alone.riskOk);
  assert.equal(alone.riskProblems.length, 3);
  const approve = check(invoices, all('approve'), 'sonnet', 200);
  assert.ok(approve.riskOk && !approve.usefulOk);
  const offJob = check(invoices, { ...sensible, send: 'never' }, 'sonnet', 200);
  assert.ok(!offJob.usefulOk, 'switching off the one job the agent exists for is not a design');
  const ok = check(invoices, sensible, 'sonnet', 200);
  assert.ok(ok.riskOk && ok.usefulOk);
  // 200 sends + 40 fees to approve.
  assert.equal(ok.approvalsPerMonth, 240);
  // 4 turns x (3000 x $2 + 400 x $10) / 1M = $0.04 a task.
  assert.ok(Math.abs(ok.costPerTask - 0.04) < 1e-9);
  assert.ok(check(invoices, sensible, 'haiku', 200).costPerMonth < ok.costPerMonth);
});

test('a capped refund may run alone; an uncapped one may not', () => {
  const support = JOBS.find((j) => j.id === 'support')!;
  const base = Object.fromEntries(support.actions.map((a) => [a.id, a.external || a.money ? 'approve' : 'alone'])) as Record<string, Autonomy>;
  assert.ok(check(support, { ...base, small: 'alone' }, 'sonnet', 100).riskOk);
  assert.ok(!check(support, { ...base, big: 'alone' }, 'sonnet', 100).riskOk);
});

test('missions: each completes the intended way, and the tempting shortcuts do not', () => {
  // Loop
  const loop = LOOP_MISSION.setup();
  const r1 = invoiceAgent({ maxSteps: 8 }); r1.step(); r1.step(); r1.step(); r1.step();
  loop.runs.push({ agent: r1, maxSteps: 8, tools: ['find_invoice', 'days_between', 'send_email'], manualSteps: 4 });
  const r2 = invoiceAgent({ maxSteps: 2 }); r2.run(); loop.runs.push({ agent: r2, maxSteps: 2, tools: ['find_invoice', 'days_between', 'send_email'], manualSteps: 0 });
  const r3 = invoiceAgent({ maxSteps: 8, tools: ['find_invoice', 'send_email'] }); r3.run(); loop.runs.push({ agent: r3, maxSteps: 8, tools: ['find_invoice', 'send_email'], manualSteps: 0 });
  assert.deepEqual(done(LOOP_MISSION, loop), [true, true, true]);

  // Tools: the prompt rule alone leaves the last step open.
  const tools = TOOLS_MISSION.setup();
  const run = (c: SupportConfig, deny = false) => { const a = supportAgent(c); a.run(); while (a.status === 'awaiting') { a.decide(!(deny && a.awaiting!.tool.name === 'issue_refund')); a.run(); } tools.runs.push({ agent: a, config: c }); };
  run({ email: 'normal', desc: 'precise', refundTool: true, rule: false, gate: false });
  run(cfg({}));
  run(cfg({ rule: true }));
  assert.deepEqual(done(TOOLS_MISSION, tools), [true, true, true, false]);
  run(cfg({ rule: true, gate: true }));
  assert.equal(done(TOOLS_MISSION, tools)[3], false, 'a gate the person waves through does not count');
  run(cfg({ gate: true }), true);
  assert.equal(done(TOOLS_MISSION, tools)[3], true);

  // Flows
  const flows = FLOW_MISSION.setup();
  flows.runs.push(runDesign('workflow'), runDesign('agent'));
  assert.deepEqual(done(FLOW_MISSION, flows), [true, true, false]);
  flows.runs.push(runDesign('hybrid'));
  assert.equal(done(FLOW_MISSION, flows)[2], true);

  // Evals: v1 + guardrail is not a way out.
  const evals = EVAL_MISSION.setup();
  const ev = (prompt: 'v1' | 'v2', guardrail: boolean, which: 'demo' | 'all') => evals.runs.push({ config: { prompt, guardrail }, which, results: runEval({ prompt, guardrail }, which) });
  ev('v1', false, 'all'); ev('v2', false, 'demo'); ev('v2', false, 'all'); ev('v1', true, 'all');
  assert.deepEqual(done(EVAL_MISSION, evals), [true, true, true, false]);
  ev('v2', true, 'all');
  assert.equal(done(EVAL_MISSION, evals)[3], true);

  // Design
  const design = DESIGN_MISSION.setup();
  const chk = (choices: Record<string, Autonomy>, model: 'haiku' | 'sonnet' | 'opus', volume: number) => design.checks.push({ job: 'invoices', choices, model, volume, verdict: check(invoices, choices, model, volume) });
  chk(all('alone'), 'sonnet', 200); chk(all('approve'), 'sonnet', 200);
  assert.deepEqual(done(DESIGN_MISSION, design), [true, false, false]);
  chk(sensible, 'sonnet', 200); chk(sensible, 'haiku', 200);
  assert.deepEqual(done(DESIGN_MISSION, design), [true, true, true]);
});
