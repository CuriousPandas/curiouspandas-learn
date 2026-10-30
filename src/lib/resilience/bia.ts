// A business impact analysis for a small online shop, and a tabletop exercise
// to test the plan. NIST SP 800-34 defines maximum tolerable downtime as "the
// amount of time mission/business process can be disrupted without causing
// significant harm"; here that is the last checkpoint before the impact table
// reaches "severe". The tabletop judges the plan by those true impacts, not by
// what the learner wrote down - a disruption does not read the plan first.

export type Level = 0 | 1 | 2 | 3;
export const LEVELS = ['none', 'minor', 'serious', 'severe'] as const;
export const CHECKPOINTS = [{ id: '4h', h: 4, label: '4 hours' }, { id: '1d', h: 24, label: '1 day' }, { id: '3d', h: 72, label: '3 days' }, { id: '1w', h: 168, label: '1 week' }] as const;
export type Mtd = '0' | '4h' | '1d' | '3d' | '1w' | 'longer';
export const MTD_LABEL: Record<Mtd, string> = { '0': 'under 4 hours', '4h': '4 hours', '1d': '1 day', '3d': '3 days', '1w': '1 week', longer: 'over a week' };
export const MTD_HOURS: Record<Mtd, number> = { '0': 0, '4h': 4, '1d': 24, '3d': 72, '1w': 168, longer: Infinity };

export type ProcessId = 'orders' | 'shipping' | 'payroll' | 'suppliers' | 'support' | 'newsletter';
export type Workaround = { id: string; text: string; valid: boolean; why: string };

export const PROCESSES: Record<ProcessId, { label: string; impact: [Level, Level, Level, Level]; needs: string[]; impactNote: string; workarounds: Workaround[] }> = {
  orders: {
    label: 'Take orders', impact: [2, 3, 3, 3], needs: ['order system', 'website'],
    impactNote: 'Lost sales from the first hour; by the end of a day, regulars have ordered elsewhere.',
    workarounds: [
      { id: 'phone', text: 'Take orders by phone on paper forms, enter them later', valid: true, why: 'needs only phones, the printed price list, and a banner on the website' },
      { id: 'email-in', text: 'Email orders straight into the order system', valid: false, why: 'the order system is the thing that is down' },
      { id: 'wait', text: 'Ask customers to come back tomorrow', valid: false, why: 'that is the outage, not a workaround' },
    ],
  },
  shipping: {
    label: 'Pack and ship', impact: [1, 2, 3, 3], needs: ['order system', 'warehouse staff'],
    impactNote: 'A day late is an apology; three days late is refunds and bad reviews.',
    workarounds: [
      { id: 'paper', text: 'Pack from the paper order forms, print labels on the carrier\'s website', valid: true, why: 'the carrier\'s site and the warehouse are both fine' },
      { id: 'wait', text: 'Hold everything until the order system returns', valid: false, why: 'two days of holding is past what the business can take' },
    ],
  },
  payroll: {
    label: 'Pay staff', impact: [0, 0, 3, 3], needs: ['payroll service', 'bank'],
    impactNote: 'Payday is Friday. Nobody notices until then - and then everybody does.',
    workarounds: [{ id: 'bank', text: 'Pay last month\'s amounts from the bank\'s website', valid: true, why: 'needs only the bank login and last month\'s figures' }],
  },
  suppliers: {
    label: 'Pay suppliers', impact: [0, 1, 2, 3], needs: ['accounting', 'bank'],
    impactNote: 'Invoices have 30 days, but the flour supplier stops delivering after a week overdue.',
    workarounds: [{ id: 'bank', text: 'Pay urgent invoices from the bank\'s website', valid: true, why: 'needs only the bank login and the invoices' }],
  },
  support: {
    label: 'Answer customer email', impact: [1, 2, 2, 3], needs: ['email', 'order system'],
    impactNote: 'Slow replies annoy; a week of silence turns into chargebacks.',
    workarounds: [{ id: 'template', text: 'Reply with a holding message and a phone number', valid: true, why: 'email itself still works' }],
  },
  newsletter: {
    label: 'Send the newsletter', impact: [0, 0, 0, 1], needs: ['mailing tool'],
    impactNote: 'A late newsletter is a late newsletter.',
    workarounds: [],
  },
};

export const IDS = Object.keys(PROCESSES) as ProcessId[];

/** The true MTD: the last checkpoint before the impact first reaches severe. */
export function trueMtd(p: ProcessId): Mtd {
  const i = PROCESSES[p].impact.findIndex((l) => l === 3);
  if (i < 0) return 'longer';
  return i === 0 ? '0' : CHECKPOINTS[i - 1].id;
}

export const TABLETOP = { label: 'The order system is down for two days (the vendor\'s outage, not yours)', down: 'order system', hours: 48 };

export type TabletopLine = { p: ProcessId; affected: boolean; ok: boolean; note: string };

export function tabletop(choice: Partial<Record<ProcessId, string>>): TabletopLine[] {
  return IDS.map((p): TabletopLine => {
    const proc = PROCESSES[p];
    if (!proc.needs.includes(TABLETOP.down)) return { p, affected: false, ok: true, note: 'not affected' };
    const canWait = MTD_HOURS[trueMtd(p)] >= TABLETOP.hours;
    const w = proc.workarounds.find((x) => x.id === choice[p]);
    if (w?.valid) return { p, affected: true, ok: true, note: `workaround holds: ${w.why}` };
    if (canWait) return { p, affected: true, ok: true, note: w ? `that workaround fails (${w.why}), but this can wait two days` : 'no workaround, but this can wait two days' };
    return { p, affected: true, ok: false, note: w ? `fails: ${w.why}. ${proc.impactNote}` : `no workaround, and it cannot wait two days. ${proc.impactNote}` };
  });
}

export type BiaState = { mtd: Partial<Record<ProcessId, Mtd>>; runs: TabletopLine[][] };
export const mtdsRight = (s: BiaState) => IDS.every((p) => s.mtd[p] === trueMtd(p));
/** The order in which to bring processes back: least tolerance first. */
export const recoveryOrder = () => [...IDS].sort((a, b) => MTD_HOURS[trueMtd(a)] - MTD_HOURS[trueMtd(b)]);
