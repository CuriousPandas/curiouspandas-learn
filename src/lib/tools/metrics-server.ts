// metrics-server: whether the Metrics API can do what it is being asked to do.
// Cards are from the sources in src/content/lessons/tools/metrics-server.mdx; any card
// marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const METRICS_SERVER_DECK: Deck = {
  id: 'tool-metrics-server', title: 'Can the autoscaler see?', xp: 40,
  cards: [
    {
      id: 'norequest', title: 'Numbers in top, unknown in the HPA',
      body: 'kubectl top pods shows a worker at 300m CPU. The HPA on it, targeting 50% CPU utilisation, shows unknown under TARGETS and has never scaled. The worker\'s containers set CPU limits but no CPU requests.',
      options: [
        { id: 'a', text: 'metrics-server is down and needs restarting', why: 'kubectl top reads the same Metrics API the HPA does. It answering is the evidence that metrics-server is working.' },
        { id: 'b', text: 'Utilisation is undefined without a CPU request, so the HPA takes no action', why: 'Supported. The HPA docs say that if some of the Pod\'s containers have no relevant resource request, CPU utilization is not defined and the autoscaler takes no action for that metric.' },
        { id: 'c', text: 'The HPA is waiting out its 5-minute window before it scales', why: 'The 5-minute window applies to scaling down. Scaling up is decided at the next check, and only if there is a utilisation to compare.' },
      ],
      answer: 'b', source: 'Kubernetes docs: Horizontal Pod Autoscaling (v1.37)',
    },
    {
      id: 'quiet', title: 'Eight per cent, one pod',
      body: 'At 3 a.m. the hello HPA shows 8%/50% under TARGETS with 1 replica, its minimum. kubectl top nodes answers. The pods request 10m CPU.',
      options: [
        { id: 'a', text: 'Working as intended: it can see, the load is low, and it sits at its minimum', why: 'Supported. A percentage under TARGETS means the HPA has usage and a request to divide by. Low traffic and minReplicas explain the single pod.' },
        { id: 'b', text: 'Broken: an HPA should always run more than one replica', why: 'The HPA keeps to the minReplicas it was given. One pod at 8% of its request is the expected answer at a quiet hour.' },
        { id: 'c', text: 'Suspicious: 8% is too low to be real, so metrics must be missing', why: 'Missing metrics show as unknown, not as a low percentage. 8% of a 10m request is under 1m of CPU, which is plausible for an idle web app.' },
      ],
      answer: 'a', source: 'TemplateMechanics/tilt lab 05; Kubernetes docs: Horizontal Pod Autoscaling',
    },
    {
      id: 'chargeback', title: 'Charging teams by CPU',
      body: 'A platform team plans to bill each team monthly for CPU by polling the Metrics API every minute and adding up what kubectl top would show.',
      options: [
        { id: 'a', text: 'Fine: metrics-server collects every 15 seconds, so a per-minute poll is detailed enough', why: 'How often it collects is not the issue. Its README says it is not an accurate source of resource usage metrics.' },
        { id: 'b', text: 'Fine, as long as metrics-server runs with more replicas', why: 'More replicas make it more available, not more accurate or longer-lived. It still only serves the latest figures.' },
        { id: 'c', text: 'Wrong tool: metrics-server is meant only for autoscaling', why: 'Supported. The README says not to use it as a source for monitoring solutions, and to collect from the kubelet\'s /metrics/resource endpoint directly for that.' },
      ],
      answer: 'c', source: 'kubernetes-sigs/metrics-server README (caution box and use cases)',
    },
  ],
  debrief: 'metrics-server serves the latest CPU and memory figures so autoscalers can act on them. A working kubectl top proves the Metrics API answers, not that an HPA can use it: utilisation also needs a request on every container. And for history, billing or alerts, use a monitoring system.',
};

export const METRICS_SERVER_DECK_MISSION = deckMission(METRICS_SERVER_DECK);
