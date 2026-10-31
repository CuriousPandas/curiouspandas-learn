// Kubernetes: whether a Service actually has anything behind it. Cards are from the sources in
// src/content/lessons/tools/kubernetes.mdx; any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const KUBERNETES_DECK: Deck = {
  id: 'tool-kubernetes', title: 'Is anything behind this Service?', xp: 40,
  cards: [
    {
      id: 'typo-selector', title: 'Resolves, then nothing',
      body: 'Service shop selects app=shpo. The shop pods are labelled app=shop and Running. The name shop resolves from inside a pod, and every request to it fails.',
      options: [
        { id: 'a', text: 'Cluster DNS is broken', why: 'The name resolves, so DNS did its part. The Debug Services guide checks DNS first precisely so you can rule it out and move on.' },
        { id: 'b', text: 'The selector matches no pods, so the Service has no endpoints', why: 'Supported. A control loop evaluates each Service selector into EndpointSlices; a typo leaves them empty, and the guide names a typo as the common mistake.' },
        { id: 'c', text: 'The pods are crashing', why: 'They are Running. The pods are fine; the Service is not pointing at them.' },
      ],
      answer: 'b', source: 'Kubernetes docs - Debug Services (v1.37)',
    },
    {
      id: 'no-selector', title: 'A Service with no selector',
      body: 'Service legacy-db has no selector at all. Someone created an EndpointSlice for it by hand, pointing at a database outside the cluster. Requests to legacy-db reach that database.',
      options: [
        { id: 'a', text: 'Working as intended: a Service without a selector uses the endpoints you define', why: 'Supported. The Service docs describe Services without selectors for exactly this, with EndpointSlices you manage yourself, and say access works the same way.' },
        { id: 'b', text: 'Broken: every Service must have a selector', why: 'Selectors are the common case, not a requirement. Kubernetes documents selector-less Services for backends it does not run.' },
        { id: 'c', text: 'Broken: it will stop working at the next reconcile', why: 'Nothing reconciles it away. With no selector, the EndpointSlice controller has nothing to compute, and the slice you wrote stays as written.' },
      ],
      answer: 'a', source: 'Kubernetes docs - Service (v1.37), Services without selectors',
    },
    {
      id: 'not-ready', title: 'Addresses, and still no traffic',
      body: 'Service api selects its pods correctly; its EndpointSlice lists two pod addresses. Both pods are Running, but their readiness probe fails, and the slice shows them as not serving.',
      options: [
        { id: 'a', text: 'The selector has a typo', why: 'A typo would leave the slice with no addresses. These pods were found; they are just not Ready.' },
        { id: 'b', text: 'The EndpointSlice controller is stuck', why: 'It recorded exactly what is true: two endpoints, neither serving. That is the controller working.' },
        { id: 'c', text: 'The pods are not Ready, so their endpoints are marked not serving and get no traffic', why: 'Supported. For a pod-backed endpoint the serving condition maps to the pod Ready condition, and serving is what marks an endpoint as a target for traffic.' },
      ],
      answer: 'c', source: 'Kubernetes docs - EndpointSlices (v1.37), Conditions',
    },
  ],
  debrief: 'A Service is a name and an address; the EndpointSlices are the answer to whether anything is behind it. Empty means the selector matched nothing, not-serving means the pods are not Ready, and a hand-written slice with no selector is a supported design, not a fault.',
};

export const KUBERNETES_DECK_MISSION = deckMission(KUBERNETES_DECK);
