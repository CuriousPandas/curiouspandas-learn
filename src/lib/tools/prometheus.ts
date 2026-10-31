// Prometheus: whether an alert expression can see an outage, and what Prometheus is not for.
// Cards are from the sources in src/content/lessons/tools/prometheus.mdx; any card
// marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const PROMETHEUS_DECK: Deck = {
  id: 'tool-prometheus', title: 'Would this alert have told you?', xp: 40,
  cards: [
    {
      id: 'gone', title: 'A quiet alerts page',
      body: 'The api team alerts on up{job="api"} == 0. During a tidy-up someone deletes the ServiceMonitor for api. An hour later the alerts page is empty and the api is not being scraped at all.',
      options: [
        { id: 'a', text: 'All is well: no alert means nothing is down', why: 'The alerts page is empty because the expression has nothing to evaluate, not because api was checked and found healthy.' },
        { id: 'b', text: 'The alert cannot fire: with no target there is no up series to compare with 0', why: 'Supported. Comparisons filter, and an alert is active only for elements the expression returns. No target, no up series, no elements, no alert.' },
        { id: 'c', text: 'Prometheus itself must be broken, or it would have raised an error', why: 'An empty result is a normal answer in PromQL, not an error. Prometheus is doing exactly what the rule asked.' },
      ],
      answer: 'b', source: 'Prometheus docs: alerting rules, operators, jobs and instances (3.15)',
    },
    {
      id: 'pending', title: 'Zero, and waiting',
      body: 'One instance of job="api" has up = 0 because its scrapes are timing out. The alert up{job="api"} == 0 has for: 5m, and two minutes in it shows as pending, not firing.',
      options: [
        { id: 'a', text: 'Working as intended: the target exists, the scrape failed, and the alert waits out its for clause', why: 'Supported. up is 0 when a scrape fails, so the expression returns a series. Elements that are active but not yet firing are in the pending state until the for duration passes.' },
        { id: 'b', text: 'A false alarm: the series must be stale, so the alert will clear itself', why: 'A failed scrape writes up = 0; that is a fresh sample saying the scrape failed, not stale data.' },
        { id: 'c', text: 'Broken: an alert that is pending has failed to evaluate', why: 'Pending is a normal state. It is the for clause doing its job, so a blip does not page anyone.' },
      ],
      answer: 'a', source: 'Prometheus docs: alerting rules (for, pending); jobs and instances (up)',
    },
    {
      id: 'billing', title: 'Charging by the request',
      body: 'Finance asks for each customer to be billed per API request, using the request counters Prometheus already scrapes from every service.',
      options: [
        { id: 'a', text: 'Fine: Prometheus counters are exact, so the bill will be too', why: 'Prometheus says itself that its collected data will likely not be detailed and complete enough for this.' },
        { id: 'b', text: 'Fine, as long as retention is raised to cover the billing period', why: 'Keeping data longer does not make it complete. Missed scrapes and restarts still leave gaps.' },
        { id: 'c', text: 'Use something else for billing and keep Prometheus for monitoring', why: 'Supported. The overview says that if you need 100% accuracy, such as for per-request billing, Prometheus is not a good choice, and suggests another system for the billing data.' },
      ],
      answer: 'c', source: 'Prometheus docs: overview, when does it not fit?',
    },
  ],
  debrief: 'Prometheus answers questions about the series it has. An alert is a query that returns rows, so it can see a target that is failing but not a target that is gone: pair up == 0 with absent(). And it is built to keep monitoring through failures, not to be an exact ledger.',
};

export const PROMETHEUS_DECK_MISSION = deckMission(PROMETHEUS_DECK);
