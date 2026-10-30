// Unit economics for one paying customer, with the definitions a16z uses in
// "16 Startup Metrics": expected lifetime in months = 1 / monthly churn, and
// lifetime value = contribution margin x lifetime. The scenario's numbers are
// the toy shop's own, not industry benchmarks - your numbers come from your data.

export const FACTS = {
  /** What one customer costs you each month: servers, SMS, payment fees. */
  costToServe: 1.5,
  /** Everything spent to win one paying customer. */
  cac: 60,
  /** Share of monthly customers who cancel each month. */
  monthlyChurn: 0.05,
  /** Annual plans are billed upfront at 10 months' price: two months free. */
  annualMonths: 10,
};

export type Billing = 'monthly' | 'annual';
export type Result = {
  price: number; billing: Billing;
  grossPerMonth: number;
  paybackMonths: number;      // Infinity when each month loses money
  lifetimeMonths: number;
  ltv: number;
  upfront: number;            // cash in on day one
  paysBack: boolean;          // within the customer's expected lifetime
  verdict: string;
};

export function economics(price: number, billing: Billing = 'monthly'): Result {
  if (!(price > 0)) throw new Error('price must be positive');
  // An annual customer pays 10 months' price for 12, so every per-month figure
  // uses that discounted price. The first version used the sticker price here,
  // and showed $6 annual earning $4.50 a month (really $3.50) and an LTV of $90
  // (really $70) - the discount applied to the cash and nowhere else.
  const effective = billing === 'annual' ? (price * FACTS.annualMonths) / 12 : price;
  const grossPerMonth = effective - FACTS.costToServe;
  const lifetimeMonths = 1 / FACTS.monthlyChurn;
  const paybackMonths = grossPerMonth > 0 ? FACTS.cac / grossPerMonth : Infinity;
  const ltv = Math.max(0, grossPerMonth) * lifetimeMonths;
  const upfront = billing === 'annual' ? price * FACTS.annualMonths : price;
  const paysBack = paybackMonths <= lifetimeMonths;
  const verdict = billing === 'annual'
    ? upfront < FACTS.cac ? `The upfront payment leaves $${(FACTS.cac - upfront).toFixed(2)} of acquisition unpaid on day one.`
      : grossPerMonth * 12 >= FACTS.cac ? 'The upfront payment covers acquisition on day one, and a year of profit repays it.'
      : `The upfront payment covers acquisition on day one, but a year at the discounted price earns $${(grossPerMonth * 12).toFixed(2)} after serving them - they repay their $${FACTS.cac} only if they renew.`
    : grossPerMonth <= 0 ? 'Every customer loses money every month. More customers means bigger losses.'
    : !paysBack ? `Never pays back: the average customer leaves after ${lifetimeMonths.toFixed(0)} months, before covering the $${FACTS.cac} it cost to win them.`
    : `Pays back in ${paybackMonths.toFixed(1)} months; the average customer stays ${lifetimeMonths.toFixed(0)}.`;
  return { price, billing, grossPerMonth, paybackMonths, lifetimeMonths, ltv, upfront, paysBack, verdict };
}

/** Lowest whole-dollar monthly price that pays back acquisition within `months`. */
export function lowestPriceForPayback(months: number): number {
  for (let p = 1; p <= 1000; p++) if (economics(p).paybackMonths <= months) return p;
  throw new Error('no price found');
}

/** Lowest whole-dollar price whose annual upfront payment covers acquisition. */
export function lowestAnnualPrice(): number {
  return Math.ceil(FACTS.cac / FACTS.annualMonths);
}
