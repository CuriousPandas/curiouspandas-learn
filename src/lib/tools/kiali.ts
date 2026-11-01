// Kiali: what the graph's absences, padlocks and TCP edges actually say. Cards are from the sources in
// src/content/lessons/tools/kiali.mdx; any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const KIALI_DECK: Deck = {
  id: 'tool-kiali', title: 'What is the graph telling you?', xp: 40,
  cards: [
    {
      id: 'tcp-edges', title: 'TCP and nothing else',
      body: 'An ambient namespace has no waypoint. Kiali\'s graph shows TCP edges between its services, with byte rates but no request counts or HTTP error rates.',
      options: [
        { id: 'a', text: 'Working as intended: ztunnel reports all traffic as TCP, and request-level telemetry needs a waypoint', why: 'Supported. Kiali\'s ambient docs say the ztunnel will report all the traffic as TCP. HTTP-level telemetry in ambient mode comes from waypoint proxies.' },
        { id: 'b', text: 'Broken: Kiali has failed to decode the HTTP', why: 'Kiali does not decode traffic. It draws what the proxies reported to Prometheus, and ztunnel reports connections.' },
        { id: 'c', text: 'Broken: the services must have dropped out of the mesh', why: 'Nothing here points to that. TCP-only edges are what ztunnel reports for the traffic it carries, which is the expected picture with no waypoint.' },
      ],
      answer: 'a', source: 'Kiali docs: Istio Ambient Mesh, ambient telemetry',
    },
    {
      id: 'quiet', title: 'A batch service vanishes',
      body: 'A batch service runs once an hour. With the graph Duration set to the last 5 minutes, it is not on the graph at all, and nothing on the page shows an error.',
      options: [
        { id: 'a', text: 'It has been removed from the mesh', why: 'Removal is one possibility, but nothing on the graph says so. An idle service and an unenrolled one leave the same gap.' },
        { id: 'b', text: 'Only that Prometheus recorded no traffic for it in that window; widen the Duration or turn on Idle Edges before concluding anything', why: 'Supported. Kiali builds the graph from Istio telemetry for the selected period, and the FAQ says the primary reason a graph is empty is no measurable traffic in that period. Idle Edges is off by default.' },
        { id: 'c', text: 'It is healthy: no edges means no errors', why: 'No edges means no recorded traffic. Absence of data is not evidence of health, in Kiali or anywhere else.' },
      ],
      answer: 'b', source: 'Kiali docs: FAQ, Graph (empty graph, Idle Edges, missing edges)',
    },
    {
      id: 'padlock', title: 'One padlock, one conclusion',
      body: 'With the Security display option on, an edge into the orders service shows a padlock. A reviewer writes: all traffic into orders is mTLS, so plaintext must be refused.',
      options: [
        { id: 'a', text: 'Correct: the padlock is only drawn when every connection is mTLS', why: 'The FAQ says lock icons are shown on edges with more than 0% mTLS traffic, not only on edges with 100%.' },
        { id: 'b', text: 'Correct, as long as the Duration covers a full day', why: 'A longer window shows more traffic; it does not change what the padlock means, and it says nothing about what orders would accept.' },
        { id: 'c', text: 'Not proven: a padlock means some of that edge\'s traffic was mTLS, and what orders accepts depends on its PeerAuthentication', why: 'Supported. Kiali shows lock icons on edges that have more than 0% mTLS traffic. Whether plaintext is refused is set by PeerAuthentication, and the default is PERMISSIVE (constructed: combining the Kiali FAQ with Istio\'s docs).' },
      ],
      answer: 'c', source: 'Kiali docs: FAQ, Graph (Security display option); Istio 1.28 docs: L4 security policy',
    },
  ],
  debrief: 'Kiali draws what Istio reported to Prometheus, for the window you chose. TCP-only edges in ambient mode are expected, a missing service is missing data rather than proof of anything, and a padlock means some mTLS was seen, not that plaintext is refused.',
};

export const KIALI_DECK_MISSION = deckMission(KIALI_DECK);
