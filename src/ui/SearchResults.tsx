/**
 * Full-text results for the Library search bar: items grouped with their
 * matching passages (transcript lines keep their timestamps). Runs on the
 * phone over SQLite FTS5, offline.
 */

import React, { useEffect, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { languageName } from '../core/language';
import { snippet } from '../core/search';
import { formatTimestamp } from '../core/transcripts';
import { getRepo } from '../services/db';
import { searchByMeaning } from '../services/semantic';
import { Chip, EmptyState, Loading, T } from './components';
import { PlatformBadge } from './media';
import { space, useTheme } from './theme';

export interface SearchHit {
  itemId: string;
  title: string;
  sourceType: string;
  passages: { text: string; startMs: number | null; kind: string; language: string | null }[];
}

type Scope = 'all' | 'transcripts' | 'notes';

export async function searchLibrary(term: string, scope: Scope = 'all'): Promise<SearchHit[]> {
  const repo = await getRepo();
  let chunks = await repo.searchChunks(term, { limit: 80 });
  if (scope === 'transcripts') chunks = chunks.filter((x) => x.kind === 'transcript');
  if (scope === 'notes') chunks = chunks.filter((x) => x.kind === 'note' || x.kind === 'summary');
  const order: string[] = [];
  const by = new Map<string, SearchHit['passages']>();
  for (const ch of chunks) {
    if (!by.has(ch.itemId)) {
      by.set(ch.itemId, []);
      order.push(ch.itemId);
    }
    const list = by.get(ch.itemId)!;
    if (list.length < 3) list.push({ text: snippet(ch.text, term), startMs: ch.startMs, kind: ch.kind, language: ch.language });
  }
  const items = await repo.itemsByIds(order.slice(0, 40));
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .filter((it) => !it.deleted)
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .map((it) => ({ itemId: it.id, title: it.title || it.url || 'Untitled', sourceType: it.sourceType, passages: by.get(it.id) ?? [] }));
}

export function SearchResults({ query, onOpen, bottomInset = 120 }: { query: string; onOpen: (itemId: string) => void; bottomInset?: number }) {
  const { c } = useTheme();
  const [scope, setScope] = useState<Scope>('all');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [meaning, setMeaning] = useState<SearchHit[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void searchLibrary(query.trim(), scope)
      .then((h) => { if (!cancelled) setHits(h); })
      .catch(() => { if (!cancelled) setHits([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, scope]);

  // Meaning-based matches (local embeddings): items about the same thing even with no shared words.
  useEffect(() => {
    let cancelled = false;
    setMeaning([]);
    const q = query.trim();
    if (scope !== 'all' || q.length < 3) return;
    const t = setTimeout(() => {
      void (async () => {
        const found = await searchByMeaning(q, 8).catch(() => []);
        if (cancelled || !found.length) return;
        const items = new Map((await (await getRepo()).itemsByIds(found.map((f) => f.itemId))).map((i) => [i.id, i]));
        if (cancelled) return;
        setMeaning(found.filter((f) => items.has(f.itemId) && !items.get(f.itemId)!.deleted).map((f) => {
          const it = items.get(f.itemId)!;
          return { itemId: f.itemId, title: it.title || it.url || 'Untitled', sourceType: it.sourceType, passages: f.passages.slice(0, 2) };
        }));
      })();
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, scope]);

  const extra = meaning.filter((m) => !(hits ?? []).some((h) => h.itemId === m.itemId));

  const renderRow = (h: SearchHit) => (
        <Pressable onPress={() => onOpen(h.itemId)} accessibilityRole="button" accessibilityLabel={h.title} style={{ paddingVertical: space.md, borderBottomWidth: 1, borderColor: c.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <PlatformBadge source={h.sourceType as never} />
            <T v="subtitle" numberOfLines={2} style={{ flex: 1 }}>{h.title}</T>
          </View>
          {h.passages.map((p, i) => (
            <View key={i} style={{ flexDirection: 'row', marginTop: 6 }}>
              <T v="caption" color="accent" style={{ width: 64 }}>{p.kind === 'transcript' ? (p.startMs !== null ? formatTimestamp(p.startMs) : 'text') : p.kind}</T>
              <T v="small" color="textMuted" style={{ flex: 1 }} numberOfLines={3}>{p.text}{p.language && p.language !== 'und' && p.kind === 'transcript' ? ` (${languageName(p.language)})` : ''}</T>
            </View>
          ))}
        </Pressable>
      );

  return (
    <FlatList
      data={hits ?? []}
      keyExtractor={(h) => h.itemId}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: bottomInset + space.lg }}
      ListHeaderComponent={
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingVertical: space.sm }}>
          {(['all', 'transcripts', 'notes'] as const).map((s) => (
            <Chip key={s} label={s === 'all' ? 'Everything' : s === 'transcripts' ? 'In transcripts' : 'Notes & summaries'} selected={scope === s} onPress={() => setScope(s)} />
          ))}
        </View>
      }
      renderItem={({ item: h }) => renderRow(h)}
      ListFooterComponent={
        <>
          {loading ? <Loading /> : null}
          {extra.length ? (
            <View style={{ marginTop: space.lg }}>
              <T v="caption" color="textMuted" accessibilityRole="header" style={{ marginBottom: space.xs }}>RELATED BY MEANING</T>
              {extra.map((h) => <View key={`m-${h.itemId}`}>{renderRow(h)}</View>)}
            </View>
          ) : null}
        </>
      }
      ListEmptyComponent={!loading && hits && !extra.length ? <EmptyState icon="search-outline" title="No results" body="Nothing you saved mentions that. Try fewer or different words." /> : null}
    />
  );
}
