// RPO and RTO on one timeline. A backup schedule decides how much data a
// disaster can take (RPO); a recovery method decides how long you are down
// (RTO). Prices are illustrative monthly figures, not quotes: the lesson is the
// shape of the trade, and the point that the same tools are overkill for one
// system and too little for another.

export type Backup = 'weekly' | 'nightly' | 'hourly' | 'quarter';
export type Recovery = 'rebuild' | 'restore' | 'standby';
export type SystemId = 'orders' | 'payroll' | 'site';

export const BACKUPS: Record<Backup, { label: string; everyH: number; offsetH: number; cost: number }> = {
  weekly: { label: 'weekly, Sunday 02:00', everyH: 168, offsetH: 2, cost: 20 },
  nightly: { label: 'nightly, 02:00', everyH: 24, offsetH: 2, cost: 40 },
  hourly: { label: 'every hour', everyH: 1, offsetH: 0, cost: 150 },
  quarter: { label: 'every 15 minutes', everyH: 0.25, offsetH: 0, cost: 400 },
};

export const RECOVERIES: Record<Recovery, { label: string; hours: number; cost: number }> = {
  rebuild: { label: 'rebuild by hand from notes', hours: 48, cost: 0 },
  restore: { label: 'restore from backup with a written runbook', hours: 3, cost: 100 },
  standby: { label: 'switch to a standby copy kept ready', hours: 0.5, cost: 900 },
};

// The targets are the business's answer to "how much can we lose, and for how
// long can we be down?" - per system. IT's job is to meet them, not pick them.
export const SYSTEMS: Record<SystemId, { label: string; rpoH: number; rtoH: number; why: string; unit: string; perHour: number }> = {
  orders: { label: 'Online orders', rpoH: 1, rtoH: 4, why: 'Each lost order is a customer charged with nothing on the way. Half a day offline and they buy elsewhere.', unit: 'orders', perHour: 30 },
  payroll: { label: 'Payroll', rpoH: 24, rtoH: 72, why: 'A day of timesheet edits can be re-entered. Staff are paid on Friday, three days away.', unit: 'timesheet edits', perHour: 4 },
  site: { label: 'Marketing site', rpoH: 168, rtoH: 48, why: 'It changes once a week, and a weekend of "back soon" costs little.', unit: 'page edits', perHour: 0.2 },
};

/** The disaster strikes on Wednesday; `atH` is the hour of the day (14.83 = 14:50). */
export const WEDNESDAY_H = 3 * 24;

export type Outcome = {
  system: SystemId; backup: Backup; recovery: Recovery;
  lostH: number; worstLostH: number; downH: number;
  rpoMet: boolean; rtoMet: boolean; cost: number; cheapest: boolean;
};

export function lastBackupBefore(backup: Backup, tH: number): number {
  const b = BACKUPS[backup];
  return Math.floor((tH - b.offsetH) / b.everyH) * b.everyH + b.offsetH;
}

export const cost = (backup: Backup, recovery: Recovery) => BACKUPS[backup].cost + RECOVERIES[recovery].cost;

export function meets(system: SystemId, backup: Backup, recovery: Recovery) {
  const s = SYSTEMS[system];
  // RPO is judged on the worst case: nobody gets to choose when the disaster comes.
  return { rpo: BACKUPS[backup].everyH <= s.rpoH, rto: RECOVERIES[recovery].hours <= s.rtoH };
}

/** The lowest monthly cost that meets both targets for a system. */
export function cheapestCost(system: SystemId): number {
  let best = Infinity;
  for (const b of Object.keys(BACKUPS) as Backup[])
    for (const r of Object.keys(RECOVERIES) as Recovery[]) {
      const m = meets(system, b, r);
      if (m.rpo && m.rto) best = Math.min(best, cost(b, r));
    }
  return best;
}

export function disaster(system: SystemId, backup: Backup, recovery: Recovery, atH: number): Outcome {
  const t = WEDNESDAY_H + atH;
  const m = meets(system, backup, recovery);
  const c = cost(backup, recovery);
  return {
    system, backup, recovery,
    lostH: t - lastBackupBefore(backup, t),
    worstLostH: BACKUPS[backup].everyH,
    downH: RECOVERIES[recovery].hours,
    rpoMet: m.rpo, rtoMet: m.rto, cost: c,
    cheapest: m.rpo && m.rto && c === cheapestCost(system),
  };
}

export function hm(hours: number): string {
  const totalMin = Math.round(hours * 60);
  const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
  return [d ? `${d} day${d > 1 ? 's' : ''}` : '', h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min';
}

export const clock = (atH: number) => `${String(Math.floor(atH)).padStart(2, '0')}:${String(Math.round((atH % 1) * 60)).padStart(2, '0')}`;
