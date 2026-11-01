// How /coverage/ words a unit. The audit's verdict is dated and never changes by
// itself: a lesson shipping doesn't prove a unit is taught, which takes someone
// reading it against the curriculum. But a stale "Not taught" beside a list of
// written lessons is false too, so a verdict overtaken by new lessons says so.

export type Verdict = 'covered' | 'partial' | 'none' | 'excluded';
export type UnitStanding = Verdict | 'reaudit';

export const STANDING_LABEL: Record<UnitStanding, string> = {
  covered: 'Covered',
  partial: 'Partly',
  none: 'Not taught',
  excluded: 'Left out on purpose',
  reaudit: 'Re-audit due',
};

export function standing(status: Verdict, plannedWritten: number): UnitStanding {
  if (status === 'covered' || status === 'excluded') return status;
  return plannedWritten > 0 ? 'reaudit' : status;
}
