import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { Image, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatLocal, rangeFor } from '../core/dates';
import { STATUS_LABELS, isPending } from '../core/status';
import { VIDEO_SOURCES } from '../core/url';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { requestSync, runDueJobs } from '../services/processing';
import { generateReport } from '../services/reports';
import { Banner, Button, Card, Chip, EmptyState, Fab, IconButton, Loading, Section, T, Wordmark } from '../ui/components';
import { useAction, useQuery } from '../ui/hooks';
import { ItemCard } from '../ui/ItemCard';
import { PlatformBadge } from '../ui/media';
import { space, useTheme } from '../ui/theme';
import { useConnection, useSettings } from '../ui/useSettings';

type Props = CompositeScreenProps<BottomTabScreenProps<TabParamList, 'Today'>, NativeStackScreenProps<RootStackParamList>>;

function Stat({ label, value, onPress }: { label: string; value: number; onPress?: () => void }) {
  return (
    <Card onPress={onPress} label={`${value} ${label}`} style={{ flex: 1, padding: space.md }}>
      <T v="display">{value}</T>
      <T v="caption" color="textMuted">{label}</T>
    </Card>
  );
}

export default function TodayScreen({ navigation }: Props) {
  const { c } = useTheme();
  const settings = useSettings();
  const tz = settings?.timezone ?? 'UTC';
  const { connection } = useConnection();
  const { busy, run } = useAction();
  const q = useQuery(
    async (repo) => {
      const r = rangeFor('today', Date.now(), tz);
      const items = await repo.itemsInRange(r.startIso, r.endIso, 50);
      return {
        range: r,
        items: [...items].reverse(),
        processing: await repo.countWhere(`status IN ('CAPTURED','METADATA_CHECK','TRANSCRIBING','ENRICHING','INDEXING')`),
        needsInput: await repo.countWhere(`status = 'NEEDS_INPUT'`),
        failed: await repo.countWhere(`status IN ('FAILED_RETRYABLE','FAILED_PERMANENT')`),
        transcripts: Number((await repo.db.get<{ n: number }>(`SELECT COUNT(DISTINCT item_id) AS n FROM transcripts t JOIN items i ON i.id = t.item_id WHERE i.deleted = 0 AND t.updated_at >= ?`, [r.startIso]))?.n ?? 0),
        clusters: await repo.tagCountsInRange(r.startIso, r.endIso),
        recent: await repo.recentlyViewed(4),
        videos: await repo.listItems({ sourceTypes: VIDEO_SOURCES }, 'newest', 8),
        conflicts: (await repo.openConflicts()).length,
        highlights: items.flatMap((i) => (i.enrichment?.keyPoints ?? []).slice(0, 1).map((p) => ({ id: i.id, text: p, origin: i.enrichment?.origin ?? 'local' }))).slice(0, 4),
      };
    },
    ['items', 'jobs', 'conflicts', 'settings'],
    [tz],
  );
  const d = q.data;

  const refresh = () =>
    run(async () => {
      if (connection) await requestSync();
      await runDueJobs();
      await q.reload();
    });

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.sm }}>
        <View style={{ flex: 1 }}>
          <Wordmark />
        </View>
        <IconButton icon="folder-open-outline" label="Collections" onPress={() => navigation.navigate('Collections')} />
        <IconButton icon="settings-outline" label="Settings" onPress={() => navigation.navigate('Settings')} />
      </View>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 96 }} refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void refresh()} />}>
        <T v="display" accessibilityRole="header">Today</T>
        <T color="textMuted">{d ? formatLocal(d.range.startIso, tz, { weekday: 'long', month: 'long', day: 'numeric' }) : ' '} · {tz}</T>
        {q.loading && !d ? <Loading /> : null}
        {q.error ? <Banner tone="danger" title="Couldn't load today" body={q.error} /> : null}
        {d ? (
          <>
            {d.conflicts ? <Banner tone="warning" title={`${d.conflicts} sync conflict(s)`} body="An item was edited on two devices. Choose which version to keep." action={<Button kind="outline" title="Review" onPress={() => navigation.navigate('Conflicts')} />} /> : null}
            {connection?.lastError ? <Banner tone="warning" title="Server unreachable" body={connection.lastError.message} action={<Button kind="outline" title="Connection" onPress={() => navigation.navigate('ConnectServer')} />} /> : null}
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg }}>
              <Stat label="saved today" value={d.items.length} onPress={() => navigation.navigate('Main', { screen: 'Library' })} />
              <Stat label="processing" value={d.processing} onPress={() => navigation.navigate('Jobs')} />
            </View>
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
              <Stat label="need a transcript" value={d.needsInput} onPress={() => navigation.navigate('Main', { screen: 'Library' })} />
              <Stat label="transcripts ready" value={d.transcripts} />
            </View>
            {d.failed ? <Banner tone="danger" title={`${d.failed} item(s) failed processing`} action={<Button kind="outline" title="Open queue" onPress={() => navigation.navigate('Jobs')} />} /> : null}

            {d.videos.length ? (
              <Section title="Recent videos" action={<T v="small" color="accent" onPress={() => navigation.navigate('Main', { screen: 'Library' })}>See all</T>}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.lg }} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md }}>
                  {d.videos.map((v) => (
                    <Pressable key={v.id} onPress={() => navigation.navigate('ItemDetail', { id: v.id })} accessibilityRole="button" accessibilityLabel={`${v.title || 'Video'}. ${STATUS_LABELS[v.status]}`} style={{ width: 220 }}>
                      <View style={{ aspectRatio: 16 / 9, borderRadius: 14, overflow: 'hidden', backgroundColor: c.surfaceAlt }}>
                        {v.thumbnailUrl ? <Image source={{ uri: v.thumbnailUrl }} style={{ width: '100%', height: '100%' }} accessibilityIgnoresInvertColors /> : null}
                        <View style={{ position: 'absolute', top: 6, left: 6 }}><PlatformBadge source={v.sourceType} onMedia /></View>
                      </View>
                      <T v="small" numberOfLines={2} style={{ marginTop: 6, fontWeight: '600' }}>{v.title || v.url}</T>
                      <T v="caption" color={isPending(v.status) ? 'info' : 'textFaint'}>{STATUS_LABELS[v.status]}</T>
                    </Pressable>
                  ))}
                </ScrollView>
              </Section>
            ) : null}

            <Card style={{ marginTop: space.lg }}>
              <T v="subtitle">Today's report</T>
              <T v="small" color="textMuted" style={{ marginVertical: space.xs }}>Summarise what you saved today, with sources, tools, repositories and gaps.</T>
              <Button
                title="Create today's report"
                icon="document-text-outline"
                loading={busy}
                onPress={() => run(async () => {
                  const r = await generateReport({ kind: 'daily', useAi: settings?.ai.enabled });
                  navigation.navigate('ReportDetail', { id: r.id });
                }, 'Report failed')}
                style={{ alignSelf: 'flex-start', marginTop: space.sm }}
              />
            </Card>

            {d.highlights.length ? (
              <Section title="Highlights">
                {d.highlights.map((h) => (
                  <Card key={h.id} onPress={() => navigation.navigate('ItemDetail', { id: h.id })} style={{ marginBottom: space.sm }} label={h.text}>
                    <T v="small">{h.text}</T>
                    <T v="caption" color="textFaint" style={{ marginTop: 4 }}>{h.origin === 'model' ? 'AI-generated key point' : 'Extracted key point'}</T>
                  </Card>
                ))}
              </Section>
            ) : null}

            {d.clusters.length ? (
              <Section title="Topics today">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                  {d.clusters.map((t) => (
                    <Chip key={t.tag} label={`${t.tag} · ${t.count}`} onPress={() => navigation.navigate('Main', { screen: 'Search' })} />
                  ))}
                </View>
              </Section>
            ) : null}

            <Section title="Saved today">
              {d.items.length ? (
                d.items.map((it) => <ItemCard key={it.id} item={it} timezone={tz} onPress={() => navigation.navigate('ItemDetail', { id: it.id })} />)
              ) : (
                <EmptyState icon="bookmark-outline" title="Nothing saved yet today" body="Share a link to Qivra from any app, or tap Save." />
              )}
            </Section>

            {d.recent.length ? (
              <Section title="Recently viewed">
                {d.recent.map((it) => <ItemCard key={it.id} item={it} timezone={tz} onPress={() => navigation.navigate('ItemDetail', { id: it.id })} />)}
              </Section>
            ) : null}
          </>
        ) : null}
      </ScrollView>
      <Fab label="Save" icon="add" onPress={() => navigation.navigate('Capture')} />
    </SafeAreaView>
  );
}
