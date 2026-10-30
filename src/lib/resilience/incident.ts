// One incident, start to postmortem. Severity wording and the roles follow
// PagerDuty's public incident response docs; the postmortem rules follow the
// Google SRE book's "Postmortem Culture" chapter. Each choice has a tempting
// wrong answer, and the checks below say why it is wrong.

export const SITUATION = 'Since 14:02, checkout fails for about 4 in 10 customers: card payments time out. The homepage and search work. A payment configuration change went out at 13:58.';

export type Sev = 1 | 2 | 3 | 4 | 5;
export const SEVERITIES: Record<Sev, string> = {
  1: 'Critical issue that warrants public notification and liaison with executive teams',
  2: 'Critical system issue actively impacting many customers\' ability to use the product',
  3: 'Stability or minor customer-impacting issues that require immediate attention from service owners',
  4: 'Minor issues requiring action, but not affecting customer ability to use the product',
  5: 'Cosmetic issues or bugs, not affecting customer ability to use the product',
};
// Many customers cannot pay: SEV-2 at least. PagerDuty: unsure between two, take the higher.
export const sevOk = (s: Sev) => s <= 2;

export type Role = 'ic' | 'resolver' | 'comms' | 'scribe';
export const ROLES: Record<Role, string> = {
  ic: 'Incident commander - coordinates, decides, never fixes',
  resolver: 'Resolver - investigates and fixes',
  comms: 'Customer liaison - writes the status updates',
  scribe: 'Scribe - keeps the timeline',
};
export const PEOPLE = ['Ana (on-call engineer, knows payments)', 'Ben (support lead)', 'Chen (engineering manager)', 'Dee (engineer, shipped the change)'];

export function staffing(a: Partial<Record<Role, number>>): { ok: boolean; why: string } {
  const roles = Object.keys(ROLES) as Role[];
  if (roles.some((r) => a[r] === undefined)) return { ok: false, why: 'Every role needs a person.' };
  const people = roles.map((r) => a[r]!);
  if (new Set(people).size !== people.length) return { ok: false, why: 'One person is holding two roles. Under pressure, one of them stops getting done - usually the coordinating.' };
  if (a.ic === 0) return { ok: false, why: 'Ana knows payments best; making her commander takes your best fixer off the fix. The commander delegates every repair.' };
  if (a.resolver !== 0 && a.resolver !== 3) return { ok: false, why: 'The resolver should be someone who can change the payment system - Ana or Dee.' };
  return { ok: true, why: 'Commander coordinates, an engineer fixes, someone talks to customers, someone writes it down.' };
}

export const UPDATES = [
  { text: 'We are investigating an issue.', ok: false, why: 'Says nothing a customer can act on: what is broken, for whom, and when they will hear more.' },
  { text: 'Card payments at checkout are failing for many customers since 14:02. We are rolling back a payment change made just before. Browsing works. Next update by 14:45.', ok: true, why: 'Impact, what is being done, what still works, and when to check back.' },
  { text: 'Dee\'s config change broke checkout. It will be fixed in ten minutes.', ok: false, why: 'Blames a person in public, and promises a time nobody knows yet.' },
];

export const FACTORS = [
  { text: 'The payment config change reached every customer at once - no canary', blame: false },
  { text: 'Dee should have been more careful', blame: true },
  { text: 'The checkout error alert fired 25 minutes after customers were affected', blame: false },
  { text: 'Config changes skip the review that code changes get', blame: false },
  { text: 'Ana was slow to answer the page', blame: true },
];

export function postmortem(chosen: number[]): { ok: boolean; why: string } {
  const set = new Set(chosen);
  const blamed = FACTORS.filter((f, i) => f.blame && set.has(i));
  if (blamed.length) return { ok: false, why: 'Naming someone as the cause is blame, not analysis. Next time, people hide the near-miss instead of reporting it.' };
  const missed = FACTORS.filter((f, i) => !f.blame && !set.has(i));
  if (missed.length) return { ok: false, why: `Still missing a contributing factor: "${missed[0].text}".` };
  return { ok: true, why: 'Three things the system allowed, each with an obvious fix: canary config changes, alert on checkout errors sooner, review config like code.' };
}

export type IncidentState = { sev?: Sev; staffing?: { ok: boolean }; update?: number; pm?: { ok: boolean } };
