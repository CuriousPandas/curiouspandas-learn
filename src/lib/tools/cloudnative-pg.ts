// CloudNativePG: whether a Ready replica, a zero lag metric or a configured archive
// means what it seems to. Cards are from the sources in
// src/content/lessons/tools/cloudnative-pg.mdx; any card marked "constructed" is our inference.

import { deckMission, type Deck } from '../cards.ts';

export const CLOUDNATIVE_PG_DECK: Deck = {
  id: 'tool-cloudnative-pg', title: 'Is that replica really there?', xp: 40,
  cards: [
    {
      id: 'stale', title: 'Ready and an hour old',
      body: 'A three-instance Cluster uses default probes. Reports read from the -ro Service. One replica\'s replay has stalled for an hour, but kubectl get pods shows it Running and Ready, and the reports keep returning rows.',
      options: [
        { id: 'a', text: 'Impossible: CloudNativePG would have marked a lagging replica unready', why: 'Only if you set the readiness probe to type: streaming with a maximumLag. The default probe does not look at lag.' },
        { id: 'b', text: 'Fine: a Ready replica is by definition caught up', why: 'Ready only means the server accepts connections. A stalled replica still does.' },
        { id: 'c', text: 'Expected with defaults: readiness is pg_isready, so the stale replica stays behind -ro and serves old data', why: 'Supported. The default readiness probe passes when the server accepts connections, and only unready pods are taken out of Services. Watch lag from the metrics instead.' },
      ],
      answer: 'c', source: 'CloudNativePG docs: instance manager probes; service management (1.30)',
    },
    {
      id: 'healthy', title: 'Zero, and streaming',
      body: 'A replica reports cnpg_pg_replication_lag 0 and cnpg_pg_replication_is_wal_receiver_up 1. On the primary, pg_stat_replication lists it as streaming. Writes on the primary show up in reads on that replica within a second.',
      options: [
        { id: 'a', text: 'Healthy: it is connected, streaming and has replayed what it received', why: 'Supported. A receiver that is up, a lag of 0 and changes visible on the replica all agree. The lag query alone could not tell you this; together with the receiver metric it can.' },
        { id: 'b', text: 'Suspicious: a lag of exactly 0 always means the metric is broken', why: 'Zero is the normal reading for a caught-up replica. It is only ambiguous when the WAL receiver is down too.' },
        { id: 'c', text: 'Broken: asynchronous replicas can never reach zero lag', why: 'Asynchronous replicas usually lag by milliseconds, and the default query reports 0 whenever everything received has been replayed.' },
      ],
      answer: 'a', source: 'cloudnative-pg/charts 0.29.0 default monitoring queries (pg_replication); CloudNativePG docs: monitoring (1.30)',
    },
    {
      id: 'archive', title: 'An archive and nothing to restore',
      body: 'A Cluster ships its WAL to object storage through the Barman Cloud plugin, and archiving reports success. Nobody created a ScheduledBackup, and no Backup has ever been taken. The primary\'s volume is lost.',
      options: [
        { id: 'a', text: 'Safe: replay the archived WAL into a new cluster', why: 'WAL needs a base backup to be replayed onto. The archive holds the changes, not the data they change.' },
        { id: 'b', text: 'Not recoverable from the object store: a WAL archive alone cannot restore a cluster without a physical base backup', why: 'Supported. CloudNativePG\'s backup docs warn that the WAL archive alone is useless, and recommend scheduled base backups and regular test restores.' },
        { id: 'c', text: 'Safe: archiving success means a full backup is taken as well', why: 'Archiving and base backups are separate. Base backups come from Backup or ScheduledBackup resources.' },
      ],
      answer: 'b', source: 'CloudNativePG docs: backup, WAL archive and scheduled backups (1.30)',
    },
  ],
  debrief: 'CloudNativePG reports what it checks. Ready means the server answers, a lag of 0 means nothing received is waiting to be replayed, and a working archive means WAL is being shipped. None of these says the replica is current or that a restore would work. Pair each signal with the one that closes its gap.',
};

export const CLOUDNATIVE_PG_DECK_MISSION = deckMission(CLOUDNATIVE_PG_DECK);
