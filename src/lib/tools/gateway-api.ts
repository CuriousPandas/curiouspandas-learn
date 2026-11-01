// Gateway API: reading an HTTPRoute's status to tell attached from ignored. Cards are from the sources in
// src/content/lessons/tools/gateway-api.mdx; any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const GATEWAY_API_DECK: Deck = {
  id: 'tool-gateway-api', title: 'Is this route carrying traffic?', xp: 40,
  cards: [
    {
      id: 'empty-parents', title: 'Applied, and silent',
      body: 'A team applies a new HTTPRoute and kubectl prints created. Ten minutes later its status.parents is an empty list, there are no events, and requests for its hostname get 404.',
      options: [
        { id: 'a', text: 'Still settling: the controller writes status within the hour', why: 'A controller that owns the parent writes status promptly. An empty list after ten minutes is an answer, not a delay.' },
        { id: 'b', text: 'Not attached: the parentRef most likely names a Gateway no controller owns, so nobody may write status for it', why: 'Supported. The docs say a Route with an invalid parentRef will have no status to indicate that, and the v1.3.0 API says an empty list means the route has not been attached to any Gateway.' },
        { id: 'c', text: 'Fine: no conditions means no problems were found', why: 'No conditions means no controller looked. Checked-and-clear would show Accepted and ResolvedRefs set to True for the parent.' },
      ],
      answer: 'b', source: 'Gateway API docs: Troubleshooting and Status; v1.3.0 RouteStatus.Parents',
    },
    {
      id: 'healthy', title: 'Two Trues and a matching generation',
      body: 'A route has one entry in status.parents, for the shared Gateway. Accepted is True with reason Accepted, ResolvedRefs is True, and each condition\'s observedGeneration equals the route\'s metadata.generation. Requests return 200.',
      options: [
        { id: 'a', text: 'Working as intended: attached, backends resolved, and the status is current', why: 'Supported. Accepted and ResolvedRefs are the two route conditions to read, and an observedGeneration that matches metadata.generation is the docs\' staleness check.' },
        { id: 'b', text: 'Suspicious: a healthy route should also show Programmed True', why: 'Programmed is a condition the docs list for objects such as the Gateway, not one of the route conditions in the v1.3.0 API.' },
        { id: 'c', text: 'Unknown until you also run kubectl get httproute', why: 'The docs warn that most kubectl get commands cannot summarize conditions correctly. The status you already read is the better evidence.' },
      ],
      answer: 'a', source: 'Gateway API docs: Troubleshooting and Status; v1.3.0 route conditions',
    },
    {
      id: 'backend', title: 'Accepted, and still failing',
      body: 'A route shows Accepted True on its Gateway, so the deploy check passes. ResolvedRefs is False with reason BackendNotFound, and every request to the route gets a 500.',
      options: [
        { id: 'a', text: 'A bug in the Gateway: an accepted route should never return 500', why: 'The spec asks for exactly this. Accepted says the route attached; it says nothing about whether its backends exist.' },
        { id: 'b', text: 'A cross-namespace reference that needs a ReferenceGrant', why: 'That would show reason RefNotPermitted. BackendNotFound means the referenced object does not exist.' },
        { id: 'c', text: 'The route attached but names a Service that does not exist, and the spec requires a 500 for traffic routed to it', why: 'Supported. BackendNotFound is a ResolvedRefs reason, and the v1.3.0 API says 500 status codes MUST be returned for requests that would have gone to an invalid backend.' },
      ],
      answer: 'c', source: 'Gateway API v1.3.0: route conditions; HTTPBackendRef rules',
    },
  ],
  debrief: 'kubectl apply only checks shape. Attachment is reported by the controller that owns the parent, so an empty status.parents means nobody looked, not that nothing is wrong. Read Accepted and ResolvedRefs for every parent, and check observedGeneration so you know the status is current.',
};

export const GATEWAY_API_DECK_MISSION = deckMission(GATEWAY_API_DECK);
