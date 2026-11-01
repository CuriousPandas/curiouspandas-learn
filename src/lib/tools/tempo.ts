// Tempo: whether a missing, split or vanished trace is a fault, a sampling decision
// or a default doing its job. Cards are from the sources in
// src/content/lessons/tools/tempo.mdx; any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const TEMPO_DECK: Deck = {
  id: 'tool-tempo', title: 'Where did that trace go?', xp: 40,
  cards: [
    {
      id: 'split', title: 'Two traces for one click',
      body: 'A checkout calls the pricing service over HTTP. In Tempo, the checkout trace ends at its outgoing HTTP client span, and pricing shows a separate trace that starts at the same moment with a different trace id. Both services export spans without errors.',
      options: [
        { id: 'a', text: 'Tempo split one large trace in two to save storage', why: 'Tempo groups spans by the trace id the services sent. Two ids means the services started two traces.' },
        { id: 'b', text: 'The trace context was not propagated: pricing never received the traceparent header, so it started a new trace', why: 'Supported. With propagation, the called service creates its span in the same trace, with the caller\'s span as parent. Without the header it has no parent and starts a root span of its own.' },
        { id: 'c', text: 'Pricing samples too little, so most of its spans were dropped', why: 'Sampling decides whether spans are recorded at all. It does not give the spans that were recorded a new trace id.' },
      ],
      answer: 'b', source: 'OpenTelemetry docs: context propagation; W3C Trace Context',
    },
    {
      id: 'aged', title: 'Gone after a day',
      body: 'On the tilt platform, a trace id copied from a log line yesterday morning found a full trace. Today, two days later, Tempo cannot find it. The spans-received counter is still going up and new traces appear within seconds.',
      options: [
        { id: 'a', text: 'Working as configured: the chart\'s retention is 24h and tilt does not change it, so old traces are deleted', why: 'Supported. The tempo chart sets retention: 24h, which becomes the compactor\'s block retention. Ingestion is healthy; the old trace was deleted on schedule.' },
        { id: 'b', text: 'Ingestion has stopped, so the trace was never stored', why: 'It was stored: it was found yesterday. And the counter shows spans still arriving.' },
        { id: 'c', text: 'The trace id was copied wrongly', why: 'The same id worked yesterday. What changed is the trace\'s age, not the id.' },
      ],
      answer: 'a', source: 'grafana/helm-charts tempo 1.24.4 values (retention); TemplateMechanics/tilt Tempo HelmRelease',
    },
    {
      id: 'unsampled', title: 'Every response a 200',
      body: 'A new edge proxy is put in front of three services. Since then Tempo has had no traces for them, though every request succeeds. The proxy forwards traceparent headers ending in -00. The services use OpenTelemetry SDK defaults.',
      options: [
        { id: 'a', text: 'Tempo is down: if it were up, it would have stored the spans', why: 'Tempo can only store spans that are sent. Here none are being recorded in the first place.' },
        { id: 'b', text: 'The services crash before exporting, but the proxy hides the errors', why: 'Every request succeeds. Nothing points to a crash; the spans are simply not recorded.' },
        { id: 'c', text: 'The proxy marks every request not sampled, and the default ParentBased sampler follows it', why: 'Supported. Flags 00 mean the caller did not record the request. ParentBased(root=AlwaysOn) uses AlwaysOff for a remote parent that was not sampled, so all three services record nothing.' },
      ],
      answer: 'c', source: 'OpenTelemetry specification: Tracing SDK samplers; W3C Trace Context, sampled flag',
    },
  ],
  debrief: 'Tempo stores what it is sent and keeps it for as long as it is told to. A split trace points at propagation, a missing trace with healthy services points at sampling, and an old trace that vanished on schedule is retention working. Ask what was sent before deciding what Tempo did.',
};

export const TEMPO_DECK_MISSION = deckMission(TEMPO_DECK);
