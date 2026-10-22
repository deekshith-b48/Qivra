import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { Grade } from '../core/flashcards';
import { formatTimestamp } from '../core/transcripts';
import type { Card as Flashcard } from '../db/types';
import type { RootProps } from '../navigation/types';
import { gradeCard } from '../services/flashcards';
import { Button, Card, EmptyState, Header, Loading, Screen, T } from '../ui/components';
import { useAction, useQuery } from '../ui/hooks';
import { radius, space, useTheme } from '../ui/theme';

const GRADES: { grade: Grade; label: string; kind: 'danger' | 'outline' | 'tonal' | 'filled' }[] = [
  { grade: 'again', label: 'Again', kind: 'danger' },
  { grade: 'hard', label: 'Hard', kind: 'outline' },
  { grade: 'good', label: 'Good', kind: 'filled' },
  { grade: 'easy', label: 'Easy', kind: 'tonal' },
];

export default function ReviewScreen({ navigation, route }: RootProps<'Review'>) {
  const { c } = useTheme();
  const collectionId = route.params?.collectionId;
  const { busy, run } = useAction();
  // The session is loaded once; grading moves through it locally ("Again" goes to the back).
  const q = useQuery(async (repo) => {
    const cards = await repo.dueCards(new Date().toISOString(), 50, collectionId);
    const titles: Record<string, string> = {};
    for (const it of await repo.itemsByIds([...new Set(cards.map((x) => x.itemId))])) titles[it.id] = it.title || it.url || 'Untitled';
    const collection = collectionId ? await repo.getCollection(collectionId) : null;
    return { cards, titles, collection };
  }, [], [collectionId]);
  const [queue, setQueue] = useState<Flashcard[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  useEffect(() => {
    if (q.data && queue === null) setQueue(q.data.cards);
  }, [q.data, queue]);

  const title = q.data?.collection ? `Review · ${q.data.collection.name}` : 'Review';
  const back = () => navigation.goBack();
  if (!queue) return <Screen><Header title={title} onBack={back} /><Loading /></Screen>;
  const card = queue[0];

  const grade = (g: Grade) => run(async () => {
    const next = await gradeCard(card.id, g);
    setRevealed(false);
    setReviewed((n) => n + 1);
    setQueue((cur) => {
      const rest = (cur ?? []).slice(1);
      return g === 'again' && next ? [...rest, next] : rest;
    });
  }, 'Could not save the review');

  return (
    <Screen>
      <Header title={title} subtitle="Flashcards from what you saved, spaced so you remember them." onBack={back} />
      {!card ? (
        <EmptyState icon="checkmark-done-outline" title="Done for today"
          body={reviewed ? `You reviewed ${reviewed} card${reviewed === 1 ? '' : 's'}. New cards come due as you learn them.` : 'No cards are due. Make flashcards from an item page.'}
          action={<Button kind="outline" title="Back" onPress={() => navigation.goBack()} />} />
      ) : (
        <>
          <T v="caption" color="textMuted" accessibilityLabel={`${reviewed} reviewed, ${queue.length} left`}>{reviewed} reviewed · {queue.length} left</T>
          <View style={{ height: 4, backgroundColor: c.surfaceAlt, borderRadius: 2, marginTop: space.xs, marginBottom: space.md }}>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: c.primary, width: `${Math.round((reviewed / (reviewed + queue.length)) * 100)}%` }} />
          </View>
          <Card>
            <T v="caption" color="textMuted" numberOfLines={1}>{q.data?.titles[card.itemId] ?? ''}</T>
            <T v="title" style={{ marginTop: space.sm }}>{card.front}</T>
            {revealed ? (
              <View style={{ marginTop: space.lg, paddingTop: space.md, borderTopWidth: 1, borderTopColor: c.border }}>
                <T v="subtitle" color="accent">{card.back}</T>
                {card.startMs !== null ? (
                  <Pressable accessibilityRole="link" accessibilityLabel={`Play from ${formatTimestamp(card.startMs)}`} hitSlop={8}
                    onPress={() => navigation.navigate('ItemDetail', { id: card.itemId, at: card.startMs ?? undefined })}
                    style={{ alignSelf: 'flex-start', marginTop: space.sm, backgroundColor: c.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <T v="small">▶ {formatTimestamp(card.startMs)}</T>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </Card>
          {revealed ? (
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg }}>
              {GRADES.map((g) => <Button key={g.grade} kind={g.kind} title={g.label} disabled={busy} onPress={() => void grade(g.grade)} style={{ flex: 1 }} />)}
            </View>
          ) : (
            <Button title="Show answer" icon="eye-outline" style={{ marginTop: space.lg }} onPress={() => setRevealed(true)} />
          )}
        </>
      )}
    </Screen>
  );
}
