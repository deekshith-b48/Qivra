import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Image, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatLocal, rangeFor } from '../core/dates';
import { firstSentence } from '../core/enrich';
import { STATUS_LABELS } from '../core/status';
import type { Item } from '../db/types';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { requestSync, runDueJobs } from '../services/processing';
import { generateReport } from '../services/reports';
import { Banner, Button, Card, Chip, EmptyState, IconButton, Loading, Section, T, Wordmark } from '../ui/components';
import { useAction, useQuery } from '../ui/hooks';
import { PlatformBadge, PLATFORM_ICONS } from '../ui/media';
import { radius, space, useTheme } from '../ui/theme';
import { useAiInfo, useConnection, useSettings } from '../ui/useSettings';

type Props = CompositeScreenProps<BottomTabScreenProps<TabParamList, 'Today'>, NativeStackScreenProps<RootStackParamList>>;

function greeting(hour: number): string {
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** A large card for something ready to look at: picture, title and its one-line summary. */
/** `width` is set for cards in the horizontal row; without it the card fills the column. */
function ReadyCard({ item, onPress, width }: { item: Item; onPress: () => void; width?: number }) {
  const { c } = useTheme();
  const tldr = item.summary ? firstSentence(item.summary) : '';
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${item.title || item.url || 'Saved item'}. ${tldr}`}
      style={({ pressed }) => ({ width, borderRadius: radius.lg, backgroundColor: c.surface, overflow: 'hidden', opacity: pressed ? 0.85 : 1 })}>
      <View style={{ aspectRatio: 16 / 9, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
        {item.thumbnailUrl ? <Image source={{ uri: item.thumbnailUrl }} style={{ width: '100%', height: '100%' }} accessibilityIgnoresInvertColors /> : <Ionicons name={PLATFORM_ICONS[item.sourceType] ?? 'document-outline'} size={36} color={c.textFaint} />}
        <View style={{ position: 'absolute', top: 8, left: 8 }}><PlatformBadge source={item.sourceType} onMedia={!!item.thumbnailUrl} /></View>
      </View>
      <View style={{ padding: space.md }}>
        <T v="subtitle" numberOfLines={2}>{item.title || item.url || 'Untitled'}</T>
        {tldr ? <T v="small" color="textMuted" numberOfLines={3} style={{ marginTop: 4 }}>{tldr}</T> : null}
      </View>
    </Pressable>
  );
}

/** A compact row with a status, used for "Needs you" and "In progress". */
function Row({ item, tone, onPress }: { item: Item; tone: 'warning' | 'danger' | 'info'; onPress: () => void }) {
  const { c } = useTheme();
  const color = tone === 'danger' ? c.danger : tone === 'warning' ? c.warning : c.info;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${item.title || item.url}. ${STATUS_LABELS[item.status]}`}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, opacity: pressed ? 0.7 : 1 })}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <View style={{ flex: 1 }}>
        <T v="small" numberOfLines={1} style={{ fontWeight: '600' }}>{item.title || item.url || 'Untitled'}</T>
        <T v="caption" color="textMuted" numberOfLines={1}>{item.errorMessage && tone !== 'info' ? item.errorMessage : STATUS_LABELS[item.status]}</T>
      </View>
      <Ionicons name="chevron-forward" size={16} color={c.textFaint} />
    </Pressable>
  );
}

export default function TodayScreen({ navigation }: Props) {
  const { c } = useTheme();
  const settings = useSettings();
  const ai = useAiInfo();
  const tz = settings?.timezone ?? 'UTC';
  const { connection } = useConnection();
  const { busy, run } = useAction();
  const q = useQuery(
    async (repo) => {
      const r = rangeFor('today', Date.now(), tz);
      const items = await repo.itemsInRange(r.startIso, r.endIso, 200);
      return {
        range: r,
        savedToday: items.length,
        feed: await repo.homeFeed(r.startIso.slice(0, 10)),
        clusters: await repo.tagCountsInRange(r.startIso, r.endIso),
        conflicts: (await repo.openConflicts()).length,
        total: await repo.countWhere('1 = 1'),
      };
    },
    ['items', 'jobs', 'conflicts', 'settings'],
    [tz],
  );
  const d = q.data;
  const due = useQuery((repo) => repo.countDueCards(new Date().toISOString()), ['cards', 'items']);
  const open = (id: string) => navigation.navigate('ItemDetail', { id });

  const refresh = () =>
    run(async () => {
      if (connection) await requestSync();
      await runDueJobs();
      await q.reload();
    });

  const hour = Number(formatLocal(new Date().toISOString(), tz, { hour: 'numeric', hourCycle: 'h23' }));
  const stats = d ? [
    `${d.savedToday} saved today`,
    d.feed.processing.length ? `${d.feed.processing.length} in progress` : '',
    d.feed.needsYou.length ? `${d.feed.needsYou.length} need you` : '',
  ].filter(Boolean).join(' · ') : ' ';

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.sm }}>
        <View style={{ flex: 1 }}>
          <Wordmark />
        </View>
        <IconButton icon="folder-open-outline" label="Collections" onPress={() => navigation.navigate('Collections')} />
        <IconButton icon="settings-outline" label="Settings" onPress={() => navigation.navigate('Settings')} />
      </View>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 48 }} refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void refresh()} />}>
        <T v="display" accessibilityRole="header">{Number.isFinite(hour) ? greeting(hour) : 'Hello'}</T>
        <T color="textMuted">{d ? `${formatLocal(d.range.startIso, tz, { weekday: 'long', month: 'long', day: 'numeric' })} · ${stats}` : ' '}</T>
        {q.loading && !d ? <Loading /> : null}
        {q.error ? <Banner tone="danger" title="Couldn't load your home feed" body={q.error} /> : null}
        {d ? (
          <>
            {d.conflicts ? <Banner tone="warning" title={`${d.conflicts} sync conflict(s)`} body="An item was edited on two devices. Choose which version to keep." action={<Button kind="outline" title="Review" onPress={() => navigation.navigate('Conflicts')} />} /> : null}
            {connection?.lastError ? <Banner tone="warning" title="Server unreachable" body={connection.lastError.message} action={<Button kind="outline" title="Connection" onPress={() => navigation.navigate('ConnectServer')} />} /> : null}

            {due.data ? (
              <Card onPress={() => navigation.navigate('Review')} label={`${due.data} flashcard${due.data === 1 ? '' : 's'} due. Review`} style={{ marginTop: space.lg }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Ionicons name="school-outline" size={22} color={c.accent} />
                  <T v="subtitle" style={{ flex: 1 }}>{due.data} card{due.data === 1 ? '' : 's'} due · Review</T>
                  <Ionicons name="chevron-forward" size={16} color={c.textFaint} />
                </View>
              </Card>
            ) : null}

            {d.feed.ready.length ? (
              <Section title="Ready to review" action={<T v="small" color="accent" onPress={() => navigation.navigate('Main', { screen: 'Library' })}>Library</T>}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.lg }} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md }}>
                  {d.feed.ready.map((it) => <ReadyCard key={it.id} item={it} width={260} onPress={() => open(it.id)} />)}
                </ScrollView>
              </Section>
            ) : null}

            {d.feed.needsYou.length ? (
              <Section title="Needs you">
                <Card style={{ paddingVertical: space.xs }}>
                  {d.feed.needsYou.map((it) => <Row key={it.id} item={it} tone={it.status === 'NEEDS_INPUT' ? 'warning' : 'danger'} onPress={() => open(it.id)} />)}
                </Card>
              </Section>
            ) : null}

            {d.feed.processing.length ? (
              <Section title="In progress">
                <Card style={{ paddingVertical: space.xs }}>
                  {d.feed.processing.map((it) => <Row key={it.id} item={it} tone="info" onPress={() => open(it.id)} />)}
                </Card>
              </Section>
            ) : null}

            {d.feed.resurface ? (
              <Section title="From your library">
                <T v="caption" color="textMuted" style={{ marginBottom: space.sm }}>
                  Saved {formatLocal(d.feed.resurface.capturedAt, tz, { dateStyle: 'medium' })}. A different one tomorrow.
                </T>
                <ReadyCard item={d.feed.resurface} onPress={() => open(d.feed.resurface!.id)} />
              </Section>
            ) : null}

            <Card style={{ marginTop: space.lg }}>
              <T v="subtitle">Today's digest</T>
              <T v="small" color="textMuted" style={{ marginVertical: space.xs }}>A report of what you saved today, with sources, tools and open questions.</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
                <Button title="Create" icon="document-text-outline" loading={busy} onPress={() => run(async () => {
                  const r = await generateReport({ kind: 'daily', useAi: ai?.enabled });
                  navigation.navigate('ReportDetail', { id: r.id });
                }, 'Report failed')} />
                <Button kind="outline" title="All reports" onPress={() => navigation.navigate('Reports')} />
              </View>
            </Card>

            {d.clusters.length ? (
              <Section title="Topics today">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                  {d.clusters.map((t) => (
                    <Chip key={t.tag} label={`${t.tag} · ${t.count}`} onPress={() => navigation.navigate('Main', { screen: 'Library', params: { q: t.tag } })} />
                  ))}
                </View>
              </Section>
            ) : null}

            {!d.total ? (
              <EmptyState icon="share-social-outline" title="Save your first reel, video or page"
                body="In Instagram, X, YouTube or your browser, tap Share → Qivra. Keep scrolling: you'll get a notification when the transcript and summary are ready. Or tap + below."
              />
            ) : !d.feed.ready.length && !d.feed.needsYou.length && !d.feed.processing.length ? (
              <EmptyState icon="checkmark-done-outline" title="You're all caught up" body="Everything you saved has been reviewed. Share something new, or ask your library a question." />
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
