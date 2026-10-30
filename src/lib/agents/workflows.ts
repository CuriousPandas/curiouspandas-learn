// Lesson 3: the same 20 support tickets, handled three ways. The token counts
// per call are illustrative, not measured; what the lesson leans on is their
// shape - a workflow's cost is flat, an agent's grows with every turn because
// each turn re-reads everything before it.

export const PRICE = { model: 'Claude Sonnet 5.5', inPerM: 2, outPerM: 10, checked: '2026-10-30' };

export type Kind = 'status' | 'refund' | 'password' | 'odd';
export type Ticket = { id: number; text: string; kind: Kind; turns: number };

// turns: how many model calls an agent needs for this ticket.
export const TICKETS: Ticket[] = [
  { id: 1, text: 'Where is order 881?', kind: 'status', turns: 3 },
  { id: 2, text: 'My parcel says delivered but it is not here', kind: 'status', turns: 4 },
  { id: 3, text: 'Refund for a broken mug, order 902', kind: 'refund', turns: 4 },
  { id: 4, text: 'I forgot my password', kind: 'password', turns: 2 },
  { id: 5, text: 'When will order 877 ship?', kind: 'status', turns: 3 },
  { id: 6, text: 'Return a jumper that does not fit', kind: 'refund', turns: 4 },
  { id: 7, text: 'Reset link expired', kind: 'password', turns: 2 },
  { id: 8, text: 'Tracking number does not work', kind: 'status', turns: 3 },
  { id: 9, text: 'Invoice is in dollars but I pay in euros, and my account is locked', kind: 'odd', turns: 8 },
  { id: 10, text: 'Where is order 893?', kind: 'status', turns: 3 },
  { id: 11, text: 'Charged twice for order 899', kind: 'refund', turns: 5 },
  { id: 12, text: 'Locked out after too many tries', kind: 'password', turns: 2 },
  { id: 13, text: 'Can your shop connect to our accounting software?', kind: 'odd', turns: 6 },
  { id: 14, text: 'Order 905 is late', kind: 'status', turns: 3 },
  { id: 15, text: 'Refund the delivery fee, it came a week late', kind: 'refund', turns: 4 },
  { id: 16, text: 'Change the address on order 910', kind: 'status', turns: 4 },
  { id: 17, text: 'New phone, cannot log in', kind: 'password', turns: 3 },
  { id: 18, text: 'Half my order arrived; also please cancel my subscription', kind: 'odd', turns: 7 },
  { id: 19, text: 'Where is order 912?', kind: 'status', turns: 3 },
  { id: 20, text: 'Discount code did not apply, refund the difference', kind: 'refund', turns: 4 },
];

export type Design = 'workflow' | 'agent' | 'hybrid';

// Per-call token shapes (illustrative).
const CLASSIFY = { in: 700, out: 10 };
const HANDLER = { in: 1300, out: 250 };
const agentTurn = (k: number) => ({ in: 1800 + 700 * k, out: 150 });

export type TicketResult = { id: number; handled: boolean; calls: number; tokensIn: number; tokensOut: number; route: string };
export type RunResult = { design: Design; tickets: TicketResult[]; handled: number; calls: number; tokensIn: number; tokensOut: number; cost: number; slowest: number };

function agentOn(t: Ticket, base = { calls: 0, tokensIn: 0, tokensOut: 0 }) {
  let { calls, tokensIn, tokensOut } = base;
  for (let k = 0; k < t.turns; k++) { const c = agentTurn(k); calls++; tokensIn += c.in; tokensOut += c.out; }
  return { calls, tokensIn, tokensOut };
}

export function runDesign(design: Design): RunResult {
  const tickets = TICKETS.map((t): TicketResult => {
    if (design === 'agent') return { id: t.id, handled: true, route: 'agent', ...agentOn(t) };
    // Both workflow designs start with one classification call.
    const classified = { calls: 1, tokensIn: CLASSIFY.in, tokensOut: CLASSIFY.out };
    if (t.kind === 'odd') {
      // The plain workflow has no "other" route: the ticket lands in the
      // nearest fixed handler, which answers the wrong question.
      if (design === 'workflow') return { id: t.id, handled: false, route: 'misrouted', calls: 2, tokensIn: classified.tokensIn + HANDLER.in, tokensOut: classified.tokensOut + HANDLER.out };
      return { id: t.id, handled: true, route: 'other -> agent', ...agentOn(t, classified) };
    }
    return { id: t.id, handled: true, route: t.kind, calls: 2, tokensIn: classified.tokensIn + HANDLER.in, tokensOut: classified.tokensOut + HANDLER.out };
  });
  const sum = (k: 'calls' | 'tokensIn' | 'tokensOut') => tickets.reduce((n, t) => n + t[k], 0);
  const tokensIn = sum('tokensIn'), tokensOut = sum('tokensOut');
  return {
    design, tickets,
    handled: tickets.filter((t) => t.handled).length,
    calls: sum('calls'), tokensIn, tokensOut,
    cost: (tokensIn * PRICE.inPerM + tokensOut * PRICE.outPerM) / 1e6,
    slowest: Math.max(...tickets.map((t) => t.calls)),
  };
}
