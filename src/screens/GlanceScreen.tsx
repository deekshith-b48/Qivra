/**
 * Glance: everything about your library at a glance. Cards due (start a review
 * right here), this week's numbers, top topics, the latest report and what you
 * saved most recently. The flashcard reviewer itself is the `Review` route.
 */

import { Ionicons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatLocal, rangeFor } from '../core/dates';
import { STATUS_LABELS } from '../core/status';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { generateReport } from '../services/reports';
import { Backdrop, Banner, Card, Chip, Loading, Section, SectionLink, T } from '../ui/components';
import { Emoji } from '../ui/Emoji';
import { useAction, useQuery } from '../ui/hooks';
import { PlatformBadge } from '../ui/media';
import { useTabBarInset } from '../ui/nav/FloatingTabBar';
import { radius, space, useTheme } from '../ui/theme';
import { StatTile, TINT_CYCLE } from '../ui/tiles';
import { useAiInfo, useSettings } from '../ui/useSettings';

// Deep green → teal: white text stays above 4.5:1 across the whole gradient (system green/teal are too light).
const HERO = ['#1A7A3F', '#0B6470'] as const;

type Props = CompositeScreenProps<BottomTabScreenProps<TabParamList, 'Glance'>, NativeStackScreenProps<RootStackParamList>>;

export default function GlanceScreen({ navigation }: Props) {
  const { c } = useTheme();
  const settings = useSettings();
  const ai = useAiInfo();
  const tz = settings?.timezone ?? 'UTC';
  const inset = useTabBarInset();
  const { busy, run } = useAction();
  const q = useQuery(async (repo) => {
    const week = rangeFor('week', Date.now(), tz);
    const feed = await repo.homeFeed(week.endIso.slice(0, 10));
    return {
      week,
      due: await repo.countDueCards(new Date().toISOString()),
      cards: await repo.cardStats(),
      savedThisWeek: (await repo.itemsInRange(week.startIso, week.endIso, 1000)).length,
      ready: await repo.countWhere(`archived = 0 AND status = 'READY' AND last_viewed_at IS NULL`),
      queue: feed.processing.length + feed.needsYou.length,
      topics: (await repo.tagCountsInRange(week.startIso, week.endIso)).slice(0, 10),
      report: (await repo.listReports(1))[0] ?? null,
      recent: await repo.listItems({}, 'newest', 3),
    };
  }, ['items', 'jobs', 'cards', 'reports', 'settings'], [tz]);
  const d = q.data;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <Backdrop />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: inset + space.lg }} refreshControl={<RefreshControl refreshing={q.loading && !!d} onRefresh={() => void q.reload()} />}>
        <T v="display" accessibilityRole="header" style={{ marginTop: space.sm }}>Glance</T>
        <T color="textMuted" style={{ marginTop: 2 }}>{formatLocal(new Date().toISOString(), tz, { weekday: 'long', month: 'long', day: 'numeric' })}</T>
        {q.loading && !d ? <Loading /> : null}
        {q.error ? <Banner tone="danger" title="Couldn't load Glance" body={q.error} /> : null}
        {d ? (
          <>
            {/* Review hero: what is due, and start right here. */}
            <LinearGradient colors={HERO} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ marginTop: space.lg, borderRadius: radius.card, padding: space.lg }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <Emoji name={d.due ? 'cards' : 'check'} size={30} />
                <T v="subtitle" style={{ color: '#FFFFFF', flex: 1 }}>{d.due ? 'Flashcards' : 'All caught up'}</T>
              </View>
              <T v="display" style={{ color: '#FFFFFF', marginTop: space.sm }} accessibilityLabel={`${d.due} cards due`}>{d.due} due</T>
              <T v="small" style={{ color: '#FFFFFFDD' }}>
                {d.cards.total ? `${d.cards.learned} of ${d.cards.total} cards learned` : 'Make flashcards from any item page'}
              </T>
              <Pressable onPress={() => (d.due ? navigation.navigate('Review') : navigation.navigate('Main', { screen: 'Library' }))} accessibilityRole="button"
                accessibilityLabel={d.due ? 'Start review' : 'Open your library'}
                style={({ pressed }) => ({ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.md, height: 40, paddingHorizontal: space.lg, borderRadius: radius.pill, backgroundColor: '#FFFFFF', opacity: pressed ? 0.85 : 1 })}>
                <Ionicons name={d.due ? 'play' : 'folder-open-outline'} size={16} color="#0B5D2A" />
                <T v="small" style={{ color: '#0B5D2A', fontWeight: '700' }}>{d.due ? 'Start review' : 'Open your library'}</T>
              </Pressable>
            </LinearGradient>

            <Section title="This week">
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <StatTile icon="bookmark" tint="blue" value={d.savedThisWeek} label="saved" onPress={() => navigation.navigate('Main', { screen: 'Library' })} />
                <StatTile icon="eye" tint="purple" value={d.ready} label="ready to read" onPress={() => navigation.navigate('Main', { screen: 'Library' })} />
              </View>
              <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
                <StatTile icon="time" tint="orange" value={d.queue} label="in queue" onPress={() => navigation.navigate('Jobs')} />
                <StatTile icon="school" tint="green" value={d.cards.learned} label="cards learned" onPress={d.due ? () => navigation.navigate('Review') : undefined} />
              </View>
            </Section>

            {d.topics.length ? (
              <Section title="Top topics this week">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {d.topics.map((t, i) => {
                    const tint = c.tint[TINT_CYCLE[i % TINT_CYCLE.length]];
                    return (
                      <Pressable key={t.tag} onPress={() => navigation.navigate('Main', { screen: 'Library', params: { q: t.tag } })} accessibilityRole="button" accessibilityLabel={`${t.tag}, ${t.count} items`}
                        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: `${tint}24`, opacity: pressed ? 0.7 : 1 })}>
                        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tint }} />
                        <T v="caption" style={{ fontWeight: '600' }}>{t.tag}</T>
                        <T v="caption" color="textMuted">{t.count}</T>
                      </Pressable>
                    );
                  })}
                </View>
              </Section>
            ) : null}

            <Section title="Latest report" action={<SectionLink label="All" onPress={() => navigation.navigate('Reports')} />}>
              <Card onPress={d.report ? () => navigation.navigate('ReportDetail', { id: d.report!.id }) : undefined} label={d.report?.title}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Emoji name="chart" size={34} />
                  <View style={{ flex: 1 }}>
                    <T v="subtitle" numberOfLines={2}>{d.report ? d.report.title : 'No report yet'}</T>
                    <T v="caption" color="textMuted">{d.report ? formatLocal(d.report.createdAt, tz, { dateStyle: 'medium', timeStyle: 'short' }) : 'A summary of what you saved, with sources.'}</T>
                  </View>
                  {d.report ? <Ionicons name="chevron-forward" size={18} color={c.textFaint} /> : (
                    <Chip label={busy ? 'Making…' : "This week's"} icon="add" onPress={() => void run(async () => {
                      const r = await generateReport({ kind: 'weekly', useAi: ai?.enabled });
                      navigation.navigate('ReportDetail', { id: r.id });
                    }, 'Report failed')} />
                  )}
                </View>
              </Card>
            </Section>

            {d.recent.length ? (
              <Section title="Recently saved" action={<SectionLink onPress={() => navigation.navigate('Main', { screen: 'Library' })} />}>
                <Card style={{ paddingVertical: space.xs }}>
                  {d.recent.map((it) => (
                    <Pressable key={it.id} onPress={() => navigation.navigate('ItemDetail', { id: it.id })} accessibilityRole="button" accessibilityLabel={it.title || it.url || 'Saved item'}
                      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, opacity: pressed ? 0.7 : 1 })}>
                      <PlatformBadge source={it.sourceType} />
                      <View style={{ flex: 1 }}>
                        <T v="small" numberOfLines={1} style={{ fontWeight: '600' }}>{it.title || it.url || 'Untitled'}</T>
                        <T v="caption" color="textMuted" numberOfLines={1}>{formatLocal(it.capturedAt, tz, { dateStyle: 'medium' })} · {STATUS_LABELS[it.status]}</T>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={c.textFaint} />
                    </Pressable>
                  ))}
                </Card>
              </Section>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
