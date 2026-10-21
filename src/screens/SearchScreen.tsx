import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { languageName } from '../core/language';
import { snippet } from '../core/search';
import { formatTimestamp } from '../core/transcripts';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { getRepo } from '../services/db';
import { Chip, EmptyState, IconButton, Loading, T } from '../ui/components';
import { useQuery } from '../ui/hooks';
import { VoiceSheet } from '../ui/VoiceSheet';
import { radius, space, type, useTheme } from '../ui/theme';

type Props = CompositeScreenProps<BottomTabScreenProps<TabParamList, 'Search'>, NativeStackScreenProps<RootStackParamList>>;

interface Hit { itemId: string; title: string; sourceType: string; passages: { text: string; startMs: number | null; kind: string; language: string | null }[] }

export default function SearchScreen({ navigation }: Props) {
  const { c } = useTheme();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | 'transcripts' | 'notes'>('all');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [voice, setVoice] = useState(false);
  const tags = useQuery(async (repo) => (await repo.allTags()).slice(0, 12), ['items']);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setHits(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const repo = await getRepo();
        let chunks = await repo.searchChunks(term, { limit: 80 });
        if (scope === 'transcripts') chunks = chunks.filter((x) => x.kind === 'transcript');
        if (scope === 'notes') chunks = chunks.filter((x) => x.kind === 'note' || x.kind === 'summary');
        const order: string[] = [];
        const by = new Map<string, Hit['passages']>();
        for (const ch of chunks) {
          if (!by.has(ch.itemId)) {
            by.set(ch.itemId, []);
            order.push(ch.itemId);
          }
          const list = by.get(ch.itemId)!;
          if (list.length < 3) list.push({ text: snippet(ch.text, term), startMs: ch.startMs, kind: ch.kind, language: ch.language });
        }
        const items = await repo.itemsByIds(order.slice(0, 40));
        if (!cancelled) setHits(items.map((it) => ({ itemId: it.id, title: it.title || it.url || 'Untitled', sourceType: it.sourceType, passages: by.get(it.id) ?? [] })));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, scope]);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ padding: space.lg, paddingBottom: space.sm }}>
        <T v="title" accessibilityRole="header">Search</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, paddingLeft: space.md, marginTop: space.sm }}>
          <TextInput value={q} onChangeText={setQ} placeholder="Titles, notes, transcripts, commands…" placeholderTextColor={c.textFaint} accessibilityLabel="Search your knowledge" style={[type.body, { flex: 1, color: c.text, minHeight: 48 }]} autoFocus returnKeyType="search" />
          {q ? <IconButton icon="close-circle" label="Clear" onPress={() => setQ('')} color={c.textMuted} /> : <IconButton icon="mic-outline" label="Search by voice" onPress={() => setVoice(true)} />}
        </View>
        <View style={{ flexDirection: 'row', marginTop: space.sm }}>
          {(['all', 'transcripts', 'notes'] as const).map((s) => <Chip key={s} label={s === 'all' ? 'Everything' : s === 'transcripts' ? 'Transcripts' : 'Notes & summaries'} selected={scope === s} onPress={() => setScope(s)} />)}
        </View>
        <T v="caption" color="textFaint">Keyword search runs on this phone, offline. Semantic matching is added in the AI Agent when an embedding model is configured.</T>
      </View>
      {loading ? <Loading /> : null}
      <FlatList
        data={hits ?? []}
        keyExtractor={(h) => h.itemId}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl }}
        renderItem={({ item: h }) => (
          <Pressable onPress={() => navigation.navigate('ItemDetail', { id: h.itemId })} accessibilityRole="button" accessibilityLabel={h.title} style={{ paddingVertical: space.md, borderBottomWidth: 1, borderColor: c.border }}>
            <T v="subtitle" numberOfLines={2}>{h.title}</T>
            {h.passages.map((p, i) => (
              <View key={i} style={{ flexDirection: 'row', marginTop: 4 }}>
                <T v="caption" color="accent" style={{ width: 70 }}>{p.kind === 'transcript' ? (p.startMs !== null ? formatTimestamp(p.startMs) : 'transcript') : p.kind}</T>
                <T v="small" color="textMuted" style={{ flex: 1 }} numberOfLines={3}>{p.text}{p.language && p.language !== 'und' && p.kind === 'transcript' ? ` (${languageName(p.language)})` : ''}</T>
              </View>
            ))}
          </Pressable>
        )}
        ListEmptyComponent={
          hits === null ? (
            <View>
              {tags.data?.length ? (
                <>
                  <T v="caption" color="textMuted">Your tags</T>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space.sm }}>
                    {tags.data.map((t) => <Chip key={t.tag} label={t.tag} onPress={() => setQ(t.tag)} />)}
                  </View>
                </>
              ) : <EmptyState icon="search-outline" title="Search everything you saved" body="Results include timestamped transcript passages." />}
            </View>
          ) : loading ? null : <EmptyState icon="search-outline" title="No results" body="Nothing in your library matches. Try fewer or different words." />
        }
      />
      <VoiceSheet visible={voice} onClose={() => setVoice(false)} purpose="dictate" onText={(t) => setQ(t.replace(/[.?!]+$/, ''))} onOpenSettings={() => navigation.navigate('VoiceSettings')} />
    </SafeAreaView>
  );
}
