// Lesson 5: design an agent for a small business. Every action gets an
// autonomy level, and two checks grade the design:
//   risk   - nothing that reaches outside the business, moves money or can't be
//            undone runs alone (OWASP's "excessive autonomy"). A money action
//            with a hard cap enforced in code may run alone.
//   useful - the everyday reading and drafting runs alone, and the job the agent
//            exists for is not switched off. An agent that asks permission for
//            everything is a slower inbox, not a helper.

export type Autonomy = 'alone' | 'approve' | 'never';

export type Action = {
  id: string; label: string;
  external?: boolean; money?: boolean; irreversible?: boolean; capped?: boolean;
  /** Everyday work that must run alone for the agent to be worth having. */
  core?: boolean;
  /** The thing this agent exists to get done: must not be 'never'. */
  purpose?: boolean;
  /** How often it happens per task (for the approval workload). */
  perTask: number;
};

export type Job = { id: string; title: string; actions: Action[]; profile: { turns: number; inPerTurn: number; outPerTurn: number } };

export const JOBS: Job[] = [
  {
    id: 'invoices', title: 'Chase unpaid invoices', profile: { turns: 4, inPerTurn: 3000, outPerTurn: 400 },
    actions: [
      { id: 'read', label: 'Read the list of overdue invoices', core: true, perTask: 1 },
      { id: 'draft', label: 'Draft a friendly reminder', core: true, perTask: 1 },
      { id: 'note', label: 'Add a note to the invoice record', core: true, perTask: 1 },
      { id: 'send', label: 'Email the reminder to the customer', external: true, purpose: true, perTask: 1 },
      { id: 'fee', label: 'Add a late fee', money: true, perTask: 0.2 },
      { id: 'pause', label: "Pause the customer's account", external: true, irreversible: true, perTask: 0.05 },
    ],
  },
  {
    id: 'support', title: 'Triage support email', profile: { turns: 5, inPerTurn: 4000, outPerTurn: 500 },
    actions: [
      { id: 'read', label: 'Read the new email', core: true, perTask: 1 },
      { id: 'label', label: 'Label it and route it to the right person', core: true, perTask: 1 },
      { id: 'draft', label: 'Draft a reply', core: true, perTask: 1 },
      { id: 'send', label: 'Send the reply', external: true, purpose: true, perTask: 1 },
      { id: 'small', label: 'Refund up to EUR 50 (capped in code)', money: true, capped: true, perTask: 0.1 },
      { id: 'big', label: 'Refund over EUR 50', money: true, perTask: 0.03 },
    ],
  },
  {
    id: 'leads', title: 'Follow up new leads', profile: { turns: 6, inPerTurn: 5000, outPerTurn: 600 },
    actions: [
      { id: 'read', label: 'Read the contact form', core: true, perTask: 1 },
      { id: 'research', label: "Read the company's public website", core: true, perTask: 1 },
      { id: 'crm', label: 'Add the lead to the CRM', core: true, perTask: 1 },
      { id: 'draft', label: 'Draft a follow-up email', core: true, perTask: 1 },
      { id: 'send', label: 'Send the follow-up', external: true, purpose: true, perTask: 1 },
      { id: 'book', label: 'Book a call in your calendar and invite them', external: true, perTask: 0.3 },
    ],
  },
  {
    id: 'inbox', title: 'Sort the shared inbox', profile: { turns: 3, inPerTurn: 2500, outPerTurn: 150 },
    actions: [
      { id: 'read', label: 'Read each email', core: true, perTask: 1 },
      { id: 'label', label: 'Label it', core: true, purpose: true, perTask: 1 },
      { id: 'archive', label: 'Archive newsletters (can be undone)', core: true, perTask: 0.4 },
      { id: 'forward', label: 'Forward to a colleague', perTask: 0.2 },
      { id: 'unsub', label: 'Unsubscribe from mailing lists', external: true, perTask: 0.1 },
      { id: 'delete', label: 'Delete permanently', irreversible: true, perTask: 0.1 },
    ],
  },
];

/** Prices per million tokens, from Anthropic's pricing page, checked 2026-10-30. They change - check before you budget. */
export const MODELS = [
  { id: 'haiku', label: 'Claude Haiku 5.5', inPerM: 0.1, outPerM: 0.5 },
  { id: 'sonnet', label: 'Claude Sonnet 5.5', inPerM: 2, outPerM: 10 },
  { id: 'opus', label: 'Claude Opus 5.5', inPerM: 4, outPerM: 20 },
] as const;
export type ModelId = (typeof MODELS)[number]['id'];
export const PRICES_CHECKED = '2026-10-30';

/** Minutes a person spends on one approval (an assumption the learner can see). */
export const MINUTES_PER_APPROVAL = 1;

export const risky = (a: Action) => !!(a.external || a.irreversible || (a.money && !a.capped));

export type Verdict = {
  riskOk: boolean; riskProblems: string[];
  usefulOk: boolean; usefulProblems: string[];
  approvalsPerMonth: number; reviewHours: number;
  costPerTask: number; costPerMonth: number;
};

export function check(job: Job, choices: Record<string, Autonomy>, model: ModelId, volume: number): Verdict {
  const riskProblems = job.actions.filter((a) => risky(a) && choices[a.id] === 'alone')
    .map((a) => `"${a.label}" runs alone, and it ${a.external ? 'reaches outside the business' : a.irreversible ? 'cannot be undone' : 'moves money with no cap'}`);
  const usefulProblems = [
    ...job.actions.filter((a) => a.core && choices[a.id] !== 'alone').map((a) => `"${a.label}" is everyday work - asking about it every time makes the agent slower than doing it yourself`),
    ...job.actions.filter((a) => a.purpose && choices[a.id] === 'never').map((a) => `"${a.label}" is the job - switched off, the agent never finishes anything`),
  ];
  const approvalsPerMonth = Math.round(volume * job.actions.filter((a) => choices[a.id] === 'approve').reduce((n, a) => n + a.perTask, 0));
  const m = MODELS.find((x) => x.id === model)!;
  const p = job.profile;
  const costPerTask = (p.turns * (p.inPerTurn * m.inPerM + p.outPerTurn * m.outPerM)) / 1e6;
  return {
    riskOk: riskProblems.length === 0, riskProblems,
    usefulOk: usefulProblems.length === 0, usefulProblems,
    approvalsPerMonth, reviewHours: (approvalsPerMonth * MINUTES_PER_APPROVAL) / 60,
    costPerTask, costPerMonth: costPerTask * volume,
  };
}
