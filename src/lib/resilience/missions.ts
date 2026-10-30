// Missions for the Resilience track, in the shape of src/lib/missions.ts. The
// tempting answer leaves a step open: buying every option meets the targets but
// not "for the least money"; more online copies do not survive ransomware;
// "we have backups" does not count until a restore is tested; the most
// expensive DR pattern is not the right one for a payment service that only
// needs warm standby; a workaround that needs the broken system is no workaround.

import type { Mission } from '../missions.ts';
import { type Outcome } from './rpo.ts';
import { Office } from './backups.ts';
import { type DrResult } from './dr.ts';
import { type BiaState, mtdsRight } from './bia.ts';
import { type IncidentState, sevOk, UPDATES } from './incident.ts';

export type RpoState = { outcomes: Outcome[] };

export const RPO_MISSION: Mission<RpoState> = {
  id: 'rpo-rto-targets', title: 'Targets come from the business', xp: 50,
  setup: () => ({ outcomes: [] }),
  steps: [
    { text: 'Online orders, nightly backups: let the disaster hit and read what it cost', hint: 'System: Online orders, backups: nightly, then "Disaster strikes"', done: (s) => s.outcomes.some((o) => o.system === 'orders' && o.backup === 'nightly') },
    { text: 'Meet the targets for Online orders: lose at most 1 hour, back within 4 hours', hint: 'How often must you back up to never lose more than an hour?', done: (s) => s.outcomes.some((o) => o.system === 'orders' && o.rpoMet && o.rtoMet) },
    { text: 'Now meet them for the least money a month', hint: 'Backing up every 15 minutes with a standby copy meets the targets - and costs five times what they need', done: (s) => s.outcomes.some((o) => o.system === 'orders' && o.cheapest) },
    { text: 'Payroll can redo a day of edits and wait three days. Meet that for the least money too', hint: 'What orders needed is overkill here', done: (s) => s.outcomes.some((o) => o.system === 'payroll' && o.cheapest) },
  ],
  debrief: 'The same disaster cost hours of orders on one schedule and minutes on another. The targets came from what each system is worth to the business - an hour of orders, a day of payroll edits - and the cheapest setup that met them was different for each. Over-protecting payroll would have spent orders\' budget on the wrong thing.',
};

export type BackupState = { office: Office };

export const BACKUP_MISSION: Mission<BackupState> = {
  id: 'backups-restore', title: 'We have backups (prove it)', xp: 60,
  setup: () => ({ office: new Office() }),
  steps: [
    { text: 'Survive the server\'s disk dying', hint: 'Any copy that is not on the same disk', done: (s) => s.office.history.some((r) => r.event === 'disk' && r.survived) },
    { text: 'Survive ransomware that goes looking for backups', hint: 'Adding more connected copies does not help. What can it not reach?', done: (s) => s.office.history.some((r) => r.event === 'ransomware' && r.survived) },
    { text: 'Run a restore drill, then fix what it finds', hint: 'Tick the cloud backup service, press "Restore drill", then fix it', done: (s) => s.office.drilled && !s.office.cloudBroken },
    { text: 'Get back a folder deleted ten days ago', hint: 'Sync copied the deletion. The offline drive is only a week old. What keeps 30 days?', done: (s) => s.office.history.some((r) => r.event === 'late-delete' && r.survived) },
  ],
  debrief: 'Three kinds of copy, three kinds of disaster. A second disk survived hardware failure, only the offline copy survived ransomware, and only versions going back 30 days rescued a mistake noticed late. And the cloud backup looked perfect on paper - offsite, versioned, counted towards 3-2-1 - while it had not worked since March. Nobody knew until someone tried to restore.',
};

export type DrState = { results: DrResult[] };

export const DR_MISSION: Mission<DrState> = {
  id: 'dr-patterns', title: 'Just enough recovery', xp: 60,
  setup: () => ({ results: [] }),
  steps: [
    { text: 'Internal wiki: survive a region outage within its targets, for the least money', hint: 'A day of downtime and a day of edits are acceptable here', done: (s) => s.results.some((r) => r.scenario === 'wiki' && r.event === 'region' && r.met && r.cheapestPattern) },
    { text: 'Online shop: the same, within 2 hours and 15 minutes of data', hint: 'Data must be replicated, but the servers can stay off until needed', done: (s) => s.results.some((r) => r.scenario === 'shop' && r.event === 'region' && r.met && r.cheapestPattern) },
    { text: 'Payment service: 15 minutes and 1 minute of data - without overpaying', hint: 'Active/active meets it at more than twice the price of what is enough', done: (s) => s.results.some((r) => r.scenario === 'payments' && r.event === 'region' && r.met && r.cheapestPattern) },
    { text: 'Online shop again: a bad deploy corrupts the orders table. Recover within its targets', hint: 'Failing over copies the corruption. What lets you go back to before it?', done: (s) => s.results.some((r) => r.scenario === 'shop' && r.event === 'corruption' && r.met) },
  ],
  debrief: 'Each workload got the cheapest pattern that met its targets - and the most expensive pattern was never the answer. Then replication, the thing that makes the fast patterns fast, faithfully copied the corruption to the standby region. Only point-in-time backups could go back to before the bad deploy.',
};

export const BIA_MISSION: Mission<BiaState> = {
  id: 'bia-tabletop', title: 'Two days without the order system', xp: 60,
  setup: () => ({ mtd: {}, runs: [] }),
  steps: [
    { text: 'Read each process\'s impact table and set how long it can be down', hint: 'The last time before the impact turns severe', done: (s) => mtdsRight(s) },
    { text: 'Run the tabletop exercise: the order system is down for two days', hint: 'Press "Run the exercise" and read what breaks', done: (s) => s.runs.length > 0 },
    { text: 'Give what cannot wait two days a workaround that does not need the order system, and run it again clean', hint: 'A workaround that sends orders into the broken system is no workaround', done: (s) => s.runs.some((r) => r.every((l) => l.ok)) },
  ],
  debrief: 'The impact tables, not anyone\'s instinct, said what could wait: orders could not last a morning, payroll could wait until Friday, the newsletter could wait for ever. The exercise found the gap before a real outage did - and the fix was paper forms and a phone, not more technology.',
};

export const INCIDENT_MISSION: Mission<IncidentState> = {
  id: 'incident-blameless', title: 'Run it, then learn from it', xp: 60,
  setup: () => ({}),
  steps: [
    { text: 'Declare a severity that fits the impact', hint: 'Many customers cannot pay. If unsure between two levels, pick the higher', done: (s) => s.sev !== undefined && sevOk(s.sev) },
    { text: 'Staff the incident: one commander who coordinates, someone else who fixes', hint: 'Your best payments engineer should be fixing, not coordinating', done: (s) => !!s.staffing?.ok },
    { text: 'Post a status update customers can act on', hint: 'What is broken, for whom, what you are doing, when they will hear next', done: (s) => s.update !== undefined && UPDATES[s.update].ok },
    { text: 'Write a blameless postmortem: every contributing factor, nobody to blame', hint: 'Ask what the system allowed, not who slipped', done: (s) => !!s.pm?.ok },
  ],
  debrief: 'The commander kept the fixers fixing, customers knew what was happening and when to look again, and the postmortem found three things the system allowed - no canary, a slow alert, unreviewed config - instead of one person to blame. Blame would have fixed nothing, and taught everyone to stay quiet next time.',
};
