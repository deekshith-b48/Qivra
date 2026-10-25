import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { formatLocal } from '../core/dates';
import type { ReportKind } from '../core/reports';
import type { RootProps } from '../navigation/types';
import { generateReport } from '../services/reports';
import { Banner, Button, Card, Chip, EmptyState, Field, Group, Header, type IconName, Row, Screen, Section, T, ToggleRow } from '../ui/components';
import { useAction, useQuery } from '../ui/hooks';
import { IconTile } from '../ui/tiles';
import { radius, space, useTheme } from '../ui/theme';
import type { TintName } from '../ui/tokens';
import { useSettings, useAiInfo } from '../ui/useSettings';

type Props = RootProps<'Reports'>;

const KINDS: [ReportKind, string, string, IconName, TintName][] = [
  ['daily', 'Today', 'Everything you saved today', 'today-outline', 'blue'],
  ['yesterday', 'Yesterday', 'Catch up on yesterday', 'arrow-undo-outline', 'indigo'],
  ['weekly', 'Weekly', 'The last 7 days, clustered by topic', 'calendar-outline', 'purple'],
  ['topic', 'Topic', 'Last 30 days filtered by a topic', 'pricetag-outline', 'orange'],
  ['developer', 'Developer', 'Tools, commands & repositories for a topic', 'code-slash-outline', 'teal'],
  ['collection', 'Collection', 'Everything in one collection (up to 300 items)', 'folder-outline', 'green'],
];

export default function ReportsScreen({ navigation }: Props) {
  const { c } = useTheme();
  const settings = useSettings();
  const ai = useAiInfo();
  const [kind, setKind] = useState<ReportKind>('daily');
  const [topic, setTopic] = useState('');
  const [collectionId, setCollectionId] = useState<string | null>(null);
  // null = not touched yet: follow whether AI is configured.
  const [aiChoice, setUseAi] = useState<boolean | null>(null);
  const useAi = aiChoice ?? !!ai?.enabled;
  const { busy, run } = useAction();
  const reports = useQuery((repo) => repo.listReports(), ['reports']);
  const collections = useQuery((repo) => repo.listCollections(), ['collections']);
  const needsTopic = kind === 'topic' || kind === 'developer';
  const needsCollection = kind === 'collection';

  return (
    <Screen>
      <Header title="Reports" subtitle={`Dates use your timezone: ${settings?.timezone ?? '…'}`} onBack={() => navigation.goBack()} />
      <Card>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {KINDS.map(([k, l, , icon, tint]) => (
            <Pressable key={k} onPress={() => setKind(k)} accessibilityRole="button" accessibilityLabel={`${l} report`} accessibilityState={{ selected: kind === k }}
              style={({ pressed }) => ({ flexBasis: '47%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderRadius: radius.tile, borderWidth: 1.5,
                borderColor: kind === k ? c.primary : c.border, backgroundColor: kind === k ? c.surfaceAlt : c.surface, opacity: pressed ? 0.75 : 1 })}>
              <IconTile icon={icon} tint={tint} size={30} />
              <T v="small" style={{ fontWeight: '600', flex: 1 }} numberOfLines={1}>{l}</T>
            </Pressable>
          ))}
        </View>
        <T v="small" color="textMuted" style={{ marginTop: space.sm }}>{KINDS.find((k) => k[0] === kind)?.[2]}</T>
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
        {reports.data?.length ? (
          <Group>
            {reports.data.map((r) => (
              <Row key={r.id} icon="document-text-outline" title={r.title} onPress={() => navigation.navigate('ReportDetail', { id: r.id })}
                subtitle={`${formatLocal(r.createdAt, r.timezone)} · ${r.itemIds.length} ${r.itemIds.length === 1 ? 'item' : 'items'}${r.provider ? ' · AI' : ''}`} />
            ))}
          </Group>
        ) : <EmptyState icon="document-text-outline" title="No reports yet" body="Generate one above. Reports are saved here and can be exported as Markdown, plain text or PDF." />}
      </Section>
    </Screen>
  );
}
