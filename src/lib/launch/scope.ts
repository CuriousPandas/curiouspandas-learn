// Scope for the same idea. The riskiest assumption is not "can I build uptime
// checks" - that is well understood - it is "will shop owners pay to hear
// quickly that their site is down". Testing it needs only three things: notice
// an outage, tell the owner, and ask for money. Everything else can wait.

export type Need = 'detect' | 'alert' | 'pay';
export type Feature = { id: string; label: string; days: number; need?: Need; byHand?: boolean };

export const FEATURES: Feature[] = [
  { id: 'accounts', label: 'Sign-up and user accounts', days: 5 },
  { id: 'billing', label: 'Subscription billing', days: 4, need: 'pay' },
  { id: 'paylink', label: 'A payment link you send by hand', days: 0.5, need: 'pay', byHand: true },
  { id: 'checker', label: 'Automatic checks every minute', days: 3, need: 'detect' },
  { id: 'manual', label: 'You check their sites with a script you run', days: 0.5, need: 'detect', byHand: true },
  { id: 'sms', label: 'SMS alerts', days: 3, need: 'alert' },
  { id: 'email', label: 'Email alerts', days: 1, need: 'alert' },
  { id: 'text', label: 'You text the owner yourself', days: 0, need: 'alert', byHand: true },
  { id: 'dashboard', label: 'Uptime dashboard with charts', days: 6 },
  { id: 'status', label: 'Public status page', days: 5 },
  { id: 'teams', label: 'Team accounts and roles', days: 6 },
  { id: 'app', label: 'Mobile app', days: 15 },
];

/** The roadmap as first imagined: every automated feature, nothing done by hand. */
export const ROADMAP = FEATURES.filter((f) => !f.byHand).map((f) => f.id);

export const NEED_LABEL: Record<Need, string> = {
  detect: 'notices an outage',
  alert: 'tells the owner',
  pay: 'asks for money',
};

export type Plan = { picked: string[]; days: number; covers: Record<Need, boolean>; learns: boolean; extras: string[] };

export function evaluate(picked: string[]): Plan {
  const fs = picked.map((id) => {
    const f = FEATURES.find((x) => x.id === id);
    if (!f) throw new Error(`no feature ${id}`);
    return f;
  });
  const covers = { detect: false, alert: false, pay: false } as Record<Need, boolean>;
  for (const f of fs) if (f.need) covers[f.need] = true;
  return {
    picked,
    days: fs.reduce((t, f) => t + f.days, 0),
    covers,
    // Without all three you learn something - but not the answer to "will they pay".
    learns: covers.detect && covers.alert && covers.pay,
    extras: fs.filter((f) => !f.need).map((f) => f.label),
  };
}
