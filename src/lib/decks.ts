// Every card deck on the site, by id, for <CardSort mission="...">. A deck
// missing from here makes CardSort refuse to build rather than render empty.

import type { Deck } from './cards.ts';
import { IN_NAME_ONLY, SCRUM_EVENTS } from './agile/cards.ts';
import { ONE_WAY_DOORS, GOLDEN_MASTER, FLAG_DEBT, API_CHANGES } from './change/cards.ts';

import { CERT_MANAGER_DECK } from './tools/cert-manager.ts';
import { CLOUDNATIVE_PG_DECK } from './tools/cloudnative-pg.ts';
import { CROSSPLANE_DECK } from './tools/crossplane.ts';
import { EXTERNAL_SECRETS_DECK } from './tools/external-secrets.ts';
import { FLAGGER_DECK } from './tools/flagger.ts';
import { FLUX_DECK } from './tools/flux.ts';
import { GATEWAY_API_DECK } from './tools/gateway-api.ts';
import { GRAFANA_DECK } from './tools/grafana.ts';
import { HELM_DECK } from './tools/helm.ts';
import { ISTIO_DECK } from './tools/istio.ts';
import { KIALI_DECK } from './tools/kiali.ts';
import { KIND_DECK } from './tools/kind.ts';
import { KUBERNETES_DECK } from './tools/kubernetes.ts';
import { LOKI_DECK } from './tools/loki.ts';
import { METRICS_SERVER_DECK } from './tools/metrics-server.ts';
import { PROMETHEUS_DECK } from './tools/prometheus.ts';
import { TEMPO_DECK } from './tools/tempo.ts';
import { TILT_DECK } from './tools/tilt.ts';
export const DECKS: Record<string, Deck> = Object.fromEntries(
  [IN_NAME_ONLY, SCRUM_EVENTS, ONE_WAY_DOORS, GOLDEN_MASTER, FLAG_DEBT, API_CHANGES, CERT_MANAGER_DECK, CLOUDNATIVE_PG_DECK, CROSSPLANE_DECK, EXTERNAL_SECRETS_DECK, FLAGGER_DECK, FLUX_DECK, GATEWAY_API_DECK, GRAFANA_DECK, HELM_DECK, ISTIO_DECK, KIALI_DECK, KIND_DECK, KUBERNETES_DECK, LOKI_DECK, METRICS_SERVER_DECK, PROMETHEUS_DECK, TEMPO_DECK, TILT_DECK].map((d) => [d.id, d]),
);
