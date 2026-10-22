/**
 * Dev: a tab for developers who opted in. Daily habits and follow-ups (Today),
 * AI and dev trends, the Claude Code corner (skills, plugins, MCP servers), and
 * a toolbox of every repo, tool and command found in your library.
 */

import { Ionicons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatLocal } from '../core/dates';
import { type ClaudeKind, type FeedItem, installCommand } from '../core/devFeeds';
import { requestsFromText } from '../core/share';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { captureRequest } from '../services/capture';
import { allTrends, getClaudeCorner, getFollowUps, getHabits, getTrends, markFollowSeen, noteTrendsChecked } from '../services/devFeeds';
import { MAX_DEV_FOLLOWS, updateSettings } from '../services/settings';
import { Backdrop, Banner, Button, Card, Chip, Field, IconButton, type IconName, Loading, Section, Sheet, Snackbar, T, ToggleRow } from '../ui/components';
import { useAction, useQuery } from '../ui/hooks';
import { Segmented } from '../ui/media';
import { useTabBarInset } from '../ui/nav/FloatingTabBar';
import { radius, space, useTheme } from '../ui/theme';
import { IconTile } from '../ui/tiles';
import type { TintName } from '../ui/tokens';
import { useSettings } from '../ui/useSettings';

type Props = CompositeScreenProps<BottomTabScreenProps<TabParamList, 'Dev'>, NativeStackScreenProps<RootStackParamList>>;
type Tab = 'today' | 'trends' | 'claude' | 'toolbox';

const SOURCE: Record<FeedItem['source'], { label: string; icon: IconName; tint: TintName; unit: IconName; unitLabel: string }> = {
  github: { label: 'GitHub', icon: 'logo-github', tint: 'gray', unit: 'star', unitLabel: 'stars' },
  hn: { label: 'Hacker News', icon: 'flame', tint: 'orange', unit: 'caret-up', unitLabel: 'points' },
  hf: { label: 'Hugging Face', icon: 'cube', tint: 'yellow', unit: 'heart', unitLabel: 'likes' },
};

const CLAUDE_SECTIONS: { kind: ClaudeKind; title: string; icon: IconName; tint: TintName }[] = [
  { kind: 'plugins', title: 'Plugins', icon: 'extension-puzzle', tint: 'purple' },
  { kind: 'skills', title: 'Skills', icon: 'school', tint: 'blue' },
  { kind: 'mcp', title: 'MCP servers', icon: 'server', tint: 'indigo' },
];

const HABITS: { key: 'saved' | 'read' | 'reviewed' | 'trends'; label: string; icon: IconName }[] = [
  { key: 'saved', label: 'Save something', icon: 'bookmark' },
  { key: 'read', label: 'Read something', icon: 'book' },
  { key: 'reviewed', label: 'Review flashcards', icon: 'layers' },
  { key: 'trends', label: 'Check the trends', icon: 'trending-up' },
];

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export default function DevScreen({ navigation }: Props) {
  const { c } = useTheme();
  const settings = useSettings();
  const tz = settings?.timezone ?? 'UTC';
  const inset = useTabBarInset();
  const { run } = useAction();
  const [tab, setTab] = useState<Tab>('today');
  const [source, setSource] = useState<'all' | FeedItem['source']>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [followOpen, setFollowOpen] = useState(false);
  const [newTerm, setNewTerm] = useState('');
  const [snack, setSnack] = useState<string | null>(null);

  const habits = useQuery(() => getHabits(), ['items', 'cards', 'settings']);
  const trends = useQuery(() => getTrends(), []);
  const follows = useQuery(() => getFollowUps(), ['settings']);
  const claude = useQuery(() => (tab === 'claude' ? getClaudeCorner() : Promise.resolve(null)), [], [tab]);
  const toolbox = useQuery((repo) => (tab === 'toolbox' || tab === 'claude' ? repo.devToolbox() : Promise.resolve(null)), ['items'], [tab]);

  // Opening the Dev tab counts as "checked the trends" today.
  useEffect(() => {
    void noteTrendsChecked().then(() => habits.reload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      if (tab === 'claude') await getClaudeCorner(true).then(() => claude.reload());
      else {
        await Promise.all([getTrends(true), getFollowUps(true)]);
        await Promise.all([trends.reload(), follows.reload()]);
      }
    } finally {
      setRefreshing(false);
    }
  };

  const save = (it: FeedItem) => run(async () => {
    const req = requestsFromText(it.url).find((r) => r.kind === 'url');
    if (!req) throw new Error('This link cannot be saved.');
    const r = await captureRequest(req);
    if (r.error) throw new Error(r.error);
    setSnack(r.duplicate ? 'Already in your library' : 'Saved to Qivra: summarising…');
    setTimeout(() => setSnack(null), 3000);
  }, 'Could not save');
  const copy = (text: string, what: string) => void Clipboard.setStringAsync(text).then(() => {
    setSnack(`${what} copied`);
    setTimeout(() => setSnack(null), 2500);
  });

  const feedCard = (it: FeedItem, kind?: ClaudeKind) => {
    const s = SOURCE[it.source];
    return (
      <Card key={it.id} style={{ marginBottom: space.sm, padding: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <IconTile icon={s.icon} tint={s.tint} size={28} />
          <T v="caption" color="textMuted" style={{ flex: 1 }} numberOfLines={1}>
            {s.label}{it.createdAt ? ` · ${formatLocal(it.createdAt, tz, { dateStyle: 'medium' })}` : ''}
          </T>
          {it.metric ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }} accessibilityLabel={`${it.metric} ${s.unitLabel}`}>
              <Ionicons name={s.unit} size={13} color={c.tint[s.tint === 'gray' ? 'yellow' : s.tint]} />
              <T v="caption" style={{ fontWeight: '700' }}>{compact(it.metric)}</T>
            </View>
          ) : null}
        </View>
        <T v="subtitle" style={{ marginTop: space.sm }} numberOfLines={2}>{it.title}</T>
        {it.description ? <T v="small" color="textMuted" numberOfLines={2} style={{ marginTop: 2 }}>{it.description}</T> : null}
        <View style={{ flexDirection: 'row', gap: space.xs, marginTop: space.sm, marginLeft: -8 }}>
          <IconButton icon="bookmark-outline" size={19} label={`Save ${it.title} to Qivra`} onPress={() => void save(it)} />
          {kind && it.repo ? <IconButton icon="terminal-outline" size={19} label={`Copy install command for ${it.title}`} onPress={() => copy(installCommand(kind, it.repo!), 'Install command')} /> : null}
          <IconButton icon="open-outline" size={19} label={`Open ${it.title}`} onPress={() => void Linking.openURL(it.url)} />
        </View>
      </Card>
    );
  };

  const h = habits.data;
  const doneCount = h ? HABITS.filter((x) => h.habits[x.key]).length : 0;
  const trendList = trends.data ? (source === 'all' ? allTrends(trends.data.data) : trends.data.data[source]) : [];

  const todayTab = (
    <>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <T v="subtitle" style={{ flex: 1 }}>Daily habits</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }} accessibilityLabel={`${h?.streak ?? 0} day streak`}>
            <Ionicons name="flame" size={18} color={h?.streak ? c.tint.orange : c.textFaint} />
            <T v="small" style={{ fontWeight: '700' }}>{h?.streak ?? 0}-day streak</T>
          </View>
        </View>
        <T v="caption" color="textMuted" style={{ marginTop: 2 }}>{doneCount} of 4 today · 3 keep your streak going</T>
        {HABITS.map((x) => {
          const done = !!h?.habits[x.key];
          return (
            <View key={x.key} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 8 }} accessibilityLabel={`${x.label}: ${done ? 'done' : 'not yet'}`}>
              <Ionicons name={done ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={done ? c.tint.green : c.textFaint} />
              <Ionicons name={x.icon} size={16} color={c.textMuted} />
              <T style={{ flex: 1, color: done ? c.textMuted : c.text, textDecorationLine: done ? 'line-through' : 'none' }}>{x.label}</T>
            </View>
          );
        })}
      </Card>

      <Section title="Follow-ups" action={<Button kind="text" title="Manage" icon="options-outline" onPress={() => setFollowOpen(true)} />}>
        {follows.loading && !follows.data ? <Loading /> : null}
        {follows.data?.error && !follows.data.data.length ? <Banner tone="warning" title="Couldn't check your topics" body={follows.data.error} /> : null}
        {!settings?.devFollows.length ? <T color="textMuted">Follow a topic or repo (like "MCP" or "anthropics/claude-code") to see what's new each day.</T> : null}
        {follows.data?.data.map((f) => (
          <Card key={f.term} style={{ marginBottom: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <IconTile icon="pulse" tint="pink" size={30} />
              <View style={{ flex: 1 }}>
                <T v="subtitle">{f.term}</T>
                <T v="caption" color="textMuted">{f.items.length ? `${f.items.length} new since ${formatLocal(new Date(f.since).toISOString(), tz, { dateStyle: 'medium' })}` : 'Nothing new yet'}</T>
              </View>
              {f.items.length ? <Button kind="text" title="Seen" onPress={() => void run(async () => { await markFollowSeen(f.term); await follows.reload(); })} /> : null}
            </View>
            {f.items.slice(0, 3).map((it) => (
              <Pressable key={it.id} onPress={() => void Linking.openURL(it.url)} accessibilityRole="link" accessibilityLabel={it.title}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6, opacity: pressed ? 0.6 : 1 })}>
                <Ionicons name={SOURCE[it.source].icon} size={15} color={c.textMuted} />
                <T v="small" numberOfLines={1} style={{ flex: 1 }}>{it.title}</T>
                <IconButton icon="bookmark-outline" size={16} label={`Save ${it.title}`} onPress={() => void save(it)} />
              </Pressable>
            ))}
          </Card>
        ))}
      </Section>

      <Section title="Top today" action={<Button kind="text" title="All trends" onPress={() => setTab('trends')} />}>
        {trends.data ? [trends.data.data.github[0], trends.data.data.hn[0], trends.data.data.hf[0]].filter(Boolean).map((it) => feedCard(it!)) : <Loading />}
      </Section>
    </>
  );

  const trendsTab = (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.lg, marginBottom: space.sm }} contentContainerStyle={{ paddingHorizontal: space.lg }}>
        {(['all', 'github', 'hn', 'hf'] as const).map((k) => (
          <Chip key={k} label={k === 'all' ? 'All' : SOURCE[k].label} icon={k === 'all' ? undefined : SOURCE[k].icon} selected={source === k} onPress={() => setSource(k)} />
        ))}
      </ScrollView>
      {trends.data?.error ? <Banner tone="warning" title="Couldn't refresh" body={trends.data.error} /> : null}
      {trends.loading && !trends.data ? <Loading /> : trendList.map((it) => feedCard(it))}
      {trends.data?.at ? <T v="caption" color="textFaint" style={{ textAlign: 'center' }}>Updated {formatLocal(new Date(trends.data.at).toISOString(), tz, { timeStyle: 'short' })} · pull to refresh</T> : null}
    </>
  );

  const libraryClaude = (toolbox.data?.tools ?? []).filter((t) => /claude|mcp|skill|agent/i.test(t.name));
  const claudeTab = (
    <>
      {claude.data?.error ? <Banner tone="warning" title="Couldn't refresh" body={claude.data.error} /> : null}
      {libraryClaude.length ? (
        <Section title="In your library">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {libraryClaude.map((t) => <Chip key={t.name} label={`${t.name} · ${t.count}`} tone="accent" onPress={() => navigation.navigate('Main', { screen: 'Library', params: { q: t.name } })} />)}
          </View>
        </Section>
      ) : null}
      {claude.loading && !claude.data ? <Loading /> : null}
      {CLAUDE_SECTIONS.map((s) => (
        claude.data?.data[s.kind]?.length ? (
          <Section key={s.kind} title={s.title}>
            {claude.data.data[s.kind].map((it) => feedCard(it, s.kind))}
          </Section>
        ) : null
      ))}
    </>
  );

  const tb = toolbox.data;
  const toolboxTab = !tb ? <Loading /> : (
    <>
      {!tb.repos.length && !tb.tools.length && !tb.commands.length ? (
        <T color="textMuted">Save GitHub repos, tutorials and dev videos: their repos, tools and commands collect here.</T>
      ) : null}
      {tb.repos.length ? (
        <Section title={`Repos (${tb.repos.length})`}>
          <Card style={{ paddingVertical: space.xs }}>
            {tb.repos.map((r) => (
              <Pressable key={r.name} onPress={() => void Linking.openURL(`https://github.com/${r.name}`)} onLongPress={() => navigation.navigate('ItemDetail', { id: r.itemIds[0] })}
                accessibilityRole="link" accessibilityLabel={`${r.name}, in ${r.count} item${r.count === 1 ? '' : 's'}`} accessibilityHint="Long press to open the item it came from"
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 8, opacity: pressed ? 0.6 : 1 })}>
                <Ionicons name="logo-github" size={18} color={c.text} />
                <T v="small" style={{ flex: 1, fontWeight: '600' }} numberOfLines={1}>{r.name}</T>
                <T v="caption" color="textMuted">{r.count}×</T>
              </Pressable>
            ))}
          </Card>
        </Section>
      ) : null}
      {tb.tools.length ? (
        <Section title="Tools">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {tb.tools.map((t) => <Chip key={t.name} label={`${t.name} · ${t.count}`} onPress={() => navigation.navigate('Main', { screen: 'Library', params: { q: t.name } })} />)}
          </View>
        </Section>
      ) : null}
      {tb.commands.length ? (
        <Section title="Commands">
          {tb.commands.map((cmd) => (
            <Card key={cmd.command} style={{ marginBottom: space.sm, padding: space.md, backgroundColor: cmd.destructive ? c.dangerSoft : c.surface }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <T v="mono" selectable style={{ flex: 1 }}>{cmd.command}</T>
                <IconButton icon="copy-outline" size={18} label={`Copy ${cmd.command}`} onPress={() => copy(cmd.command, 'Command')} />
              </View>
              {cmd.destructive ? <T v="small" color="danger">⚠ Potentially destructive: {cmd.reason}</T> : null}
            </Card>
          ))}
          <T v="caption" color="textFaint">Copied from your saved items. Qivra never runs commands.</T>
        </Section>
      ) : null}
    </>
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <Backdrop />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: inset + space.lg }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm }}>
          <T v="display" accessibilityRole="header">Dev</T>
          <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: c.tint.purple }}>
            <T v="caption" style={{ color: '#FFFFFF', fontWeight: '800' }}>BETA</T>
          </View>
        </View>
        <T color="textMuted" style={{ marginTop: 2, marginBottom: space.md }}>Trends, Claude Code and your daily dev habits.</T>
        <Segmented<Tab> value={tab} onChange={setTab} options={[{ key: 'today', label: 'Today' }, { key: 'trends', label: 'Trends' }, { key: 'claude', label: 'Claude' }, { key: 'toolbox', label: 'Toolbox' }]} />
        <View style={{ marginTop: space.md }}>
          {tab === 'today' ? todayTab : tab === 'trends' ? trendsTab : tab === 'claude' ? claudeTab : toolboxTab}
        </View>
      </ScrollView>

      <Sheet visible={followOpen} onClose={() => setFollowOpen(false)} title="Follow topics">
        <T v="small" color="textMuted">Topics or repos to watch on GitHub and Hacker News (up to {MAX_DEV_FOLLOWS}).</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: space.sm }}>
          {(settings?.devFollows ?? []).map((t) => (
            <Chip key={t} label={`${t} ✕`} onPress={() => void updateSettings({ devFollows: (settings?.devFollows ?? []).filter((x) => x !== t) })} />
          ))}
        </View>
        {(settings?.devFollows.length ?? 0) < MAX_DEV_FOLLOWS ? (
          <>
            <Field label="Add a topic or owner/repo" value={newTerm} onChangeText={setNewTerm} autoCapitalize="none" placeholder="e.g. LangGraph, anthropics/claude-code" />
            <Button title="Follow" icon="add" style={{ marginTop: space.sm }} disabled={!newTerm.trim()} onPress={() => {
              const term = newTerm.trim().slice(0, 60);
              const cur = settings?.devFollows ?? [];
              if (!cur.some((x) => x.toLowerCase() === term.toLowerCase())) void updateSettings({ devFollows: [...cur, term] });
              setNewTerm('');
            }} />
          </>
        ) : null}
        <ToggleRow icon="notifications" tint={c.tint.red} title="Morning notification" subtitle="When a followed topic has something new." value={!!settings?.devFollowNotify} onChange={(v) => void updateSettings({ devFollowNotify: v })} />
      </Sheet>
      <Snackbar bottom={inset} message={snack} />
    </SafeAreaView>
  );
}
