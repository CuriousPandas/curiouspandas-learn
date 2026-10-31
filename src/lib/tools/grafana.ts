// Grafana: telling "Grafana can't read it" from "there is nothing to read".
// Cards are from the sources in src/content/lessons/tools/grafana.mdx; any card
// marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const GRAFANA_DECK: Deck = {
  id: 'tool-grafana', title: 'Is the panel empty, or is Grafana blind?', xp: 40,
  cards: [
    {
      id: 'blank', title: 'Listed, and blank',
      body: 'After an upgrade every dashboard is blank. The Prometheus data source is still in Grafana\'s list. The same query run directly against Prometheus returns data, and Grafana\'s log shows a failed plugin install.',
      options: [
        { id: 'a', text: 'Prometheus has lost its data and needs restoring', why: 'Prometheus answers the same query directly, so the data is there.' },
        { id: 'b', text: 'The cluster is quiet, so there is nothing to draw', why: 'A quiet cluster still has up series and request counters. Blank everywhere, with data in Prometheus, points at the reader, not the source.' },
        { id: 'c', text: 'Grafana cannot read the data source: the plugin that queries it is not loaded', why: 'Supported. Grafana issue 132528 and the tilt platform both saw bundled data-source plugins left unregistered after a failed background install, while the data sources stayed in the list.' },
      ],
      answer: 'c', source: 'grafana/grafana issue 132528; TemplateMechanics/tilt helm/prometheus/helm-release.yaml',
    },
    {
      id: 'restart', title: 'Back after a restart',
      body: 'A chart change restarts Grafana on the tilt platform. Afterwards the Prometheus data source\'s health check answers OK, Explore returns the up series, and the platform\'s dashboards, all provisioned from ConfigMaps, are back.',
      options: [
        { id: 'a', text: 'Working as intended: provisioned dashboards and data sources are recreated on start, and the health check proves Grafana can read Prometheus', why: 'Supported. The dashboards come from labelled ConfigMaps that a sidecar loads, and a health check plus a real query is the evidence that the data source answers.' },
        { id: 'b', text: 'Suspicious: a restart wipes Grafana, so these must be stale copies', why: 'A restart wipes what was saved inside Grafana, not what is provisioned from ConfigMaps and chart values. Those are loaded again on start.' },
        { id: 'c', text: 'Broken until someone re-imports the dashboards by hand', why: 'Nothing needs re-importing: provisioning exists so that a rebuilt Grafana comes back the same.' },
      ],
      answer: 'a', source: 'TemplateMechanics/tilt helm/prometheus/helm-release.yaml (sidecar) and docs/GRAFANA-MCP.md; Grafana data source HTTP API',
    },
    {
      id: 'novalue', title: 'A reassuring zero',
      body: 'An error panel reads 0, as it has all week. Its No value option was set to 0 to make the panel look tidy. Nobody has checked whether the query returns any series. (Constructed from the No value option\'s documented behaviour.)',
      options: [
        { id: 'a', text: 'Healthy: zero errors all week', why: 'With No value set to 0, an empty result also shows 0, so this panel cannot tell you that.' },
        { id: 'b', text: 'Unknown: 0 may be a real zero or the No value text standing in for no data at all', why: 'Supported. Grafana shows the No value text when the field is empty or null. Run the query in Explore, or check the target in Prometheus, before trusting the zero.' },
        { id: 'c', text: 'Broken: Grafana always shows an error when a query returns nothing', why: 'An empty result is not an error to Grafana. By default it shows a hyphen; with No value set, it shows whatever text you chose.' },
      ],
      answer: 'b', source: 'Grafana docs: configure standard options, No value (v13.3); constructed',
    },
  ],
  debrief: 'Grafana draws what its data sources return, and a data source in the list is only configuration. When a panel is empty, find out whether Grafana can read the source and whether the source has anything to give, and keep the difference between nothing and zero visible.',
};

export const GRAFANA_DECK_MISSION = deckMission(GRAFANA_DECK);
