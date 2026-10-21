import React, { useState } from 'react';
import { View } from 'react-native';
import { formatLocal } from '../core/dates';
import type { ReportKind } from '../core/reports';
import type { RootProps } from '../navigation/types';
import { generateReport } from '../services/reports';
import { Banner, Button, Card, Chip, EmptyState, Field, Header, Screen, Section, T, ToggleRow } from '../ui/components';
import { useAction, useQuery } from '../ui/hooks';
import { space } from '../ui/theme';
import { useSettings, useAiInfo } from '../ui/useSettings';

type Props = RootProps<'Reports'>;

const KINDS: [ReportKind, string, string][] = [
  ['daily', "Today's report", 'Everything you saved today'],
  ['yesterday', "Yesterday's report", 'Catch up on yesterday'],
  ['weekly', 'Weekly learning report', 'The last 7 days, clustered by topic'],
  ['topic', 'Topic report', 'Last 30 days filtered by a topic'],
  ['developer', 'Developer report', 'Tools, commands & repositories for a topic'],
  ['collection', 'Collection report', 'Everything in one collection (up to 300 items)'],
];

export default function ReportsScreen({ navigation }: Props) {
  const settings = useSettings();
  const ai = useAiInfo();
  const [kind, setKind] = useState<ReportKind>('daily');
  const [topic, setTopic] = useState('');
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [useAi, setUseAi] = useState(false);
  const { busy, run } = useAction();
  const reports = useQuery((repo) => repo.listReports(), ['reports']);
  const collections = useQuery((repo) => repo.listCollections(), ['collections']);
  const needsTopic = kind === 'topic' || kind === 'developer';
  const needsCollection = kind === 'collection';

  return (
    <Screen>
      <Header title="Reports" subtitle={`Dates use your timezone: ${settings?.timezone ?? '…'}`} onBack={() => navigation.goBack()} />
      <Card>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {KINDS.map(([k, l]) => <Chip key={k} label={l} selected={kind === k} onPress={() => setKind(k)} />)}
        </View>
        <T v="small" color="textMuted">{KINDS.find((k) => k[0] === kind)?.[2]}</T>
        {needsCollection ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space.sm }}>
            {collections.data?.length
              ? collections.data.map((col) => <Chip key={col.id} label={`${col.name} (${col.itemCount})`} selected={collectionId === col.id} onPress={() => setCollectionId(col.id)} />)
              : <T v="small" color="textMuted">No collections yet. Create one in Collections.</T>}
          </View>
        ) : null}
        {needsTopic ? <Field label="Topic" value={topic} onChangeText={setTopic} placeholder="e.g. Claude Code, AI agents, React" style={{ marginTop: space.sm }} /> : null}
        <ToggleRow title="Add an AI executive summary" subtitle={ai?.enabled ? `Uses ${ai.model}; labelled as AI-generated.` : 'Configure a model in Settings → AI models.'} value={useAi && !!ai?.enabled} onChange={setUseAi} />
        <Button
          title="Generate"
          icon="document-text-outline"
          loading={busy}
          disabled={(needsTopic && !topic.trim()) || (needsCollection && !collections.data?.some((col) => col.id === collectionId))}
          onPress={() => void run(async () => {
            const r = await generateReport({ kind, topic: needsTopic ? topic.trim() : undefined, collectionId: needsCollection ? collectionId ?? undefined : undefined, useAi: useAi && ai?.enabled });
            navigation.navigate('ReportDetail', { id: r.id });
          }, 'Report failed')}
        />
        <T v="caption" color="textFaint" style={{ marginTop: space.sm }}>To report on specific items, select them in Library and choose “Report”.</T>
      </Card>
      <Section title="History">
        {reports.error ? <Banner tone="danger" title="Couldn't load reports" body={reports.error} /> : null}
        {reports.data?.length ? reports.data.map((r) => (
          <Card key={r.id} onPress={() => navigation.navigate('ReportDetail', { id: r.id })} label={r.title} style={{ marginBottom: space.sm }}>
            <T v="subtitle">{r.title}</T>
            <T v="caption" color="textMuted">{formatLocal(r.createdAt, r.timezone)} · {r.itemIds.length} item(s){r.provider ? ' · AI summary' : ''}{r.exportedAt ? ' · exported' : ''}</T>
          </Card>
        )) : <EmptyState icon="document-text-outline" title="No reports yet" body="Generate one above. Reports are saved here and can be exported as Markdown, plain text or PDF." />}
      </Section>
    </Screen>
  );
}
