/**
 * Every highlight you saved, newest first and grouped by item. Tap one to open
 * the item at that moment; remove the ones you no longer want.
 */

import React from 'react';
import { Pressable, View } from 'react-native';
import { formatLocal } from '../core/dates';
import { formatTimestamp } from '../core/transcripts';
import type { Highlight, Item } from '../db/types';
import type { RootProps } from '../navigation/types';
import { emit } from '../services/events';
import { getRepo } from '../services/db';
import { Card, EmptyState, Header, IconButton, Loading, Screen, T } from '../ui/components';
import { useAction, useQuery } from '../ui/hooks';
import { PlatformBadge, TimestampPill } from '../ui/media';
import { space, useTheme } from '../ui/theme';
import { useSettings } from '../ui/useSettings';

export default function HighlightsScreen({ navigation }: RootProps<'Highlights'>) {
  const { c } = useTheme();
  const tz = useSettings()?.timezone ?? 'UTC';
  const { run } = useAction();
  const q = useQuery(async (repo) => {
    const hs = await repo.listHighlights();
    const items = new Map((await repo.itemsByIds([...new Set(hs.map((h) => h.itemId))])).map((i) => [i.id, i]));
    // Group by item, keeping the order of each item's newest highlight.
    const groups: { item: Item; highlights: Highlight[] }[] = [];
    for (const h of hs) {
      const it = items.get(h.itemId);
      if (!it) continue;
      const g = groups.find((x) => x.item.id === it.id);
      if (g) g.highlights.push(h);
      else groups.push({ item: it, highlights: [h] });
    }
    return { groups, total: hs.length };
  }, ['items']);

  return (
    <Screen>
      <Header title="Highlights" subtitle={q.data ? `${q.data.total} saved quote${q.data.total === 1 ? '' : 's'}` : undefined} onBack={() => navigation.goBack()} />
      {q.loading && !q.data ? <Loading /> : null}
      {q.data && !q.data.total ? (
        <EmptyState icon="bookmark-outline" title="No highlights yet" body="On an item, long-press a transcript line, a key moment or the summary and choose Save highlight." />
      ) : null}
      {q.data?.groups.map(({ item, highlights }) => (
        <Card key={item.id} style={{ marginBottom: space.md }}>
          <Pressable onPress={() => navigation.navigate('ItemDetail', { id: item.id })} accessibilityRole="button" accessibilityLabel={`Open ${item.title || 'item'}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
            <PlatformBadge source={item.sourceType} />
            <T v="subtitle" numberOfLines={1} style={{ flex: 1 }}>{item.title || item.url || 'Untitled'}</T>
          </Pressable>
          {highlights.map((h) => (
            <View key={h.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: space.xs, paddingLeft: space.md, borderLeftWidth: 3, borderLeftColor: c.tint.orange, marginBottom: space.xs }}>
              <Pressable style={{ flex: 1 }} onPress={() => navigation.navigate('ItemDetail', { id: item.id, at: h.startMs ?? undefined })} accessibilityRole="button" accessibilityLabel={h.text}>
                <T v="small">{h.text}</T>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 4 }}>
                  {h.startMs !== null ? <TimestampPill label={formatTimestamp(h.startMs)} /> : null}
                  <T v="caption" color="textFaint">{formatLocal(h.createdAt, tz, { dateStyle: 'medium' })}</T>
                </View>
              </Pressable>
              <IconButton icon="close" size={16} label="Remove highlight" onPress={() => void run(async () => { await (await getRepo()).deleteHighlight(h.id); emit('items'); })} />
            </View>
          ))}
        </Card>
      ))}
    </Screen>
  );
}
