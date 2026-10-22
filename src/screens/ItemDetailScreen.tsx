import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, Linking, Pressable, ScrollView, View } from 'react-native';
import { formatLocal } from '../core/dates';
import { formatReminder, reminderPresets } from '../core/reminderTimes';
import { keyMomentsOf } from '../core/enrich';
import { extractKeywords, type Keyword } from '../core/highlights';
import { languageName, LANGUAGES } from '../core/language';
import { isFailed, isPending, STATUS_LABELS } from '../core/status';
import { formatTimestamp, type Segment } from '../core/transcripts';
import { analyzeUrl, ARTICLE_SOURCES, VIDEO_SOURCES } from '../core/url';
import type { Highlight, Item, Transcript } from '../db/types';
import type { RootProps } from '../navigation/types';
import { deleteItemFiles, pickMediaFile } from '../services/capture';
import { getRepo } from '../services/db';
import { clearItemReminders, scheduleItemReminder } from '../services/reminders';
import { emit } from '../services/events';
import { similarItems } from '../services/semantic';
import { makeCards } from '../services/flashcards';
import { cancelItemProcessing, requestModelEnrichment, requestServerProcessing, schedulePipeline } from '../services/processing';
import { ActionPill, Banner, Button, Card, Chip, Field, Header, IconButton, type IconName, Loading, Provenance, Row, Screen, Section, Sheet, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { ItemCard } from '../ui/ItemCard';
import { Markdown } from '../ui/Markdown';
import { markdownProse, stripMarkdown } from '../core/metadata';
import { HighlightedText, PlatformBadge, PLATFORM_ICONS, ProgressSteps, Segmented, TimestampPill, type StepState } from '../ui/media';
import { radius, space, useTheme } from '../ui/theme';
import { useConnection, useSettings, useAiInfo } from '../ui/useSettings';
import { YouTubeHero, type YouTubeHeroHandle } from '../ui/YouTubeHero';
import { ImageHero } from '../ui/ImageHero';

function stepsFor(item: Item, hasSpeech: boolean, hasArticle: boolean, isVideo: boolean): { label: string; state: StepState }[] {
  const s = item.status;
  const contentDone = isVideo ? hasSpeech : hasArticle || !!item.note || !!item.summary;
  const noSpeech = item.errorCode === 'INFO_NO_SPEECH';
  const content: StepState = contentDone ? 'done' : noSpeech ? 'skipped' : s === 'NEEDS_INPUT' || isFailed(s) ? 'blocked' : s === 'TRANSCRIBING' || s === 'METADATA_CHECK' || s === 'CAPTURED' ? 'active' : 'todo';
  const summary: StepState = s === 'ENRICHING' || s === 'INDEXING' ? 'active' : item.summary ? 'done' : 'todo';
  return [
    { label: 'Saved', state: 'done' },
    { label: isVideo ? 'Transcript' : 'Content', state: content },
    { label: 'Summary', state: summary },
    { label: 'Ready', state: s === 'READY' ? 'done' : 'todo' },
  ];
}

/** Starting point for a custom reminder: tomorrow at the next whole hour. */
function defaultCustom(): Date {
  const d = new Date(Date.now() + 86_400_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/** A label for non-speech text sources (articles, READMEs, OCR); null for spoken transcripts. */
function textKindLabel(source: string): string | null {
  const src = source.replace(/^server_/, '');
  if (src === 'github_readme') return 'README';
  if (src === 'web_article') return 'Article';
  if (src === 'image_ocr') return 'Text from image';
  if (src === 'video_ocr') return 'On-screen text';
  return ARTICLE_SOURCES.has(source) ? 'Text' : null;
}

export default function ItemDetailScreen({ navigation, route }: RootProps<'ItemDetail'>) {
  const { id } = route.params;
  const { c } = useTheme();
  const settings = useSettings();
  const ai = useAiInfo();
  const { connection } = useConnection();
  const tz = settings?.timezone ?? 'UTC';
  const { busy, run } = useAction();
  const [tab, setTab] = useState<'summary' | 'text' | 'details'>(route.params.at !== undefined ? 'text' : 'summary');
  const [titleOpen, setTitleOpen] = useState(false);
  const [allMoments, setAllMoments] = useState(false);
  const [captionOpen, setCaptionOpen] = useState(false);
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [edit, setEdit] = useState<null | 'title' | 'note' | 'summary' | 'tags'>(null);
  const [draft, setDraft] = useState('');
  const [langOpen, setLangOpen] = useState(false);
  const [correcting, setCorrecting] = useState<{ ordinal: number; text: string } | null>(null);
  // Long-press on a transcript line, key moment or the summary: save it as a highlight, copy it, or correct it.
  const [picked, setPicked] = useState<{ text: string; startMs: number | null; source: Highlight['source']; ordinal?: number } | null>(null);
  const [remindOpen, setRemindOpen] = useState(false);
  const [custom, setCustom] = useState<Date | null>(null);
  const highlights = useQuery((repo) => repo.listHighlights({ itemId: id }), ['items'], [id]);
  const heroRef = useRef<YouTubeHeroHandle>(null);
  const scrollRef = useRef<ScrollView>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const onTime = useCallback((ms: number) => setNowMs(ms), []);
  const cardAction = useAction();
  const [cardsMsg, setCardsMsg] = useState<string | null>(null);
  const cardCount = useQuery(async (repo) => (await repo.listCards(id)).length, ['cards'], [id]);

  const q = useQuery(async (repo) => {
    const item = await repo.getItem(id);
    if (!item || item.deleted) return null;
    return {
      item,
      transcripts: await repo.listTranscripts(id),
      jobs: await repo.listJobs({ itemId: id, limit: 10 }),
      aiJob: await repo.getJob(`job_model_enrich_${id}`),
      media: await repo.listMedia(id),
      collections: await repo.listCollections(),
      memberOf: await repo.itemCollectionIds(id),
      related: await repo.relatedItems(item, 4),
    };
  }, ['items', 'jobs', 'collections'], [id]);

  useEffect(() => {
    void (async () => (await getRepo()).markViewed(id))();
  }, [id]);

  const similar = useQuery(() => similarItems(id), ['items', 'jobs'], [id]);
  const d = q.data;
  const atParam = route.params.at;
  const videoIdForAt = d?.item.url ? analyzeUrl(d.item.url)?.youtubeId : undefined;
  useEffect(() => {
    if (atParam === undefined || !videoIdForAt) return;
    const t = setTimeout(() => heroRef.current?.seek(atParam), 300);
    return () => clearTimeout(t);
  }, [atParam, videoIdForAt]);
  const speech = d?.transcripts.filter((t) => !ARTICLE_SOURCES.has(t.source)) ?? [];
  const articles = d?.transcripts.filter((t) => ARTICLE_SOURCES.has(t.source)) ?? [];
  const ordered: Transcript[] = [...speech, ...articles];
  const activeT = ordered.find((t) => t.id === transcriptId) ?? ordered[0] ?? null;
  const segs = useQuery(async (repo) => (activeT ? repo.getSegments(activeT.id) : []), ['items'], [activeT?.id, activeT?.updatedAt]);

  const keywords: Keyword[] = useMemo(() => {
    if (!d) return [];
    const base: Segment[] = segs.data?.length ? segs.data.map((s) => (activeT?.format === 'md' ? { ...s, text: markdownProse(s.text) } : s)) : [{ startMs: null, endMs: null, text: [d.item.summary, d.item.note, d.item.metadata?.description ?? ''].join(' ') }];
    return extractKeywords(base, { tools: d.item.enrichment?.tools ?? [], concepts: d.item.enrichment?.concepts ?? [], title: d.item.title, max: 8 });
  }, [d, segs.data, activeT?.format]);
  const terms = keywords.map((k) => k.term);

  if (q.loading && !d) return <Screen><Loading /></Screen>;
  if (!d) {
    return (
      <Screen>
        <Header title="Item" onBack={() => navigation.goBack()} />
        <Banner tone="warning" title="This item no longer exists" body={q.error ?? 'It may have been deleted on this or another device.'} />
      </Screen>
    );
  }
  const { item } = d;
  const e = item.enrichment;
  const isVideo = VIDEO_SOURCES.includes(item.sourceType);
  const ytId = item.url ? analyzeUrl(item.url)?.youtubeId : undefined;
  const contentLabel = activeT ? textKindLabel(activeT.source) ?? 'Transcript' : 'Transcript';

  const repoOp = async (fn: (repo: Awaited<ReturnType<typeof getRepo>>) => Promise<unknown>) => {
    await fn(await getRepo());
    emit('items');
  };
  const openAt = (ms: number | null) => {
    if (!item.url) return;
    if (ytId) {
      // Play in place: back to the player at the top, then seek.
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      heroRef.current?.seek(ms ?? 0);
      return;
    }
    const url = ytId && ms !== null ? `https://www.youtube.com/watch?v=${ytId}&t=${Math.floor(ms / 1000)}s` : item.url;
    void Linking.openURL(url);
  };
  const startEdit = (field: 'title' | 'note' | 'summary' | 'tags') => {
    setDraft(field === 'tags' ? item.tags.join(', ') : item[field]);
    setEdit(field);
  };
  const saveEdit = () => run(async () => {
    await repoOp(async (repo) => {
      if (edit === 'tags') await repo.setTags(id, draft.split(',').map((t) => t.trim()).filter(Boolean));
      else if (edit === 'summary') await repo.updateItem(id, { summary: draft, summaryOrigin: 'user' });
      else if (edit) await repo.updateItem(id, { [edit]: draft });
    });
    setEdit(null);
  });
  const retry = () => run(async () => {
    const repo = await getRepo();
    if (item.status === 'CANCELLED') await repo.setStatus(id, 'METADATA_CHECK');
    for (const j of await repo.listJobs({ itemId: id, statuses: ['failed_permanent'] })) {
      if (j.kind === 'server_transcribe_url') await repo.enqueueJob({ id: j.id, kind: j.kind, itemId: id, retry: true, maxAttempts: 4 });
    }
    await schedulePipeline(id);
  });
  const serverAction = (kind: 'transcribe' | 'transcribe_url') => run(async () => {
    const what = { transcribe: 'upload the attached media file and transcribe it', transcribe_url: 'download this post’s audio and transcribe it' }[kind];
    if (!(await confirm('Use your server?', `Qivra will ${what} on ${connection?.serverUrl}.`, 'Continue'))) return;
    await requestServerProcessing(id, kind);
  });
  const del = () => run(async () => {
    if (!(await confirm('Delete this item?', 'Its transcripts, notes and attached media on this phone will be deleted.', 'Delete', true))) return;
    await deleteItemFiles([id]);
    await repoOp((repo) => repo.deleteItems([id]));
    navigation.goBack();
  });

  // While the embedded video plays, the line being spoken is highlighted.
  const playingIndex = nowMs === null ? -1 : (segs.data ?? []).reduce((best, sg, i) => (sg.startMs !== null && sg.startMs <= nowMs + 300 ? i : best), -1);
  // A Markdown README is stored as one block: a keyword filter shows its matching paragraphs instead.
  const isMd = activeT?.format === 'md';
  const lineSource = isMd && activeT ? stripMarkdown(activeT.text).split(/\n{2,}/).map((text) => ({ startMs: null, endMs: null, text: text.trim() })).filter((p) => p.text) : segs.data ?? [];
  const shownSegs = lineSource.map((s, i) => ({ ...s, i })).filter((s) => !focus || s.text.toLowerCase().includes(focus.toLowerCase()));
  const info = item.errorCode?.startsWith('INFO_');
  const generating = !!d.aiJob && (d.aiJob.status === 'queued' || d.aiJob.status === 'running');
  const moments = keyMomentsOf(e);
  const saveHighlight = () => run(async () => {
    if (!picked) return;
    await repoOp((r) => r.addHighlight({ itemId: id, text: picked.text, startMs: picked.startMs, source: picked.source }));
    setPicked(null);
  }, 'Could not save the highlight');
  const remind = (at: Date) => run(async () => {
    if ((await scheduleItemReminder(id, at)) === 'denied') Alert.alert('Notifications are off', 'Allow notifications for Qivra in Android settings to get reminders.');
    setRemindOpen(false);
    setCustom(null);
  }, 'Could not set the reminder');
  // Error banners offer at most one primary and one secondary action.
  type Action = { title: string; icon: IconName; onPress: () => void };
  const importT: Action = { title: 'Import transcript', icon: 'document-text-outline', onPress: () => navigation.navigate('TranscriptImport', { itemId: id }) };
  const retryA: Action = { title: 'Retry', icon: 'refresh', onPress: () => void retry() };
  const problem: { primary: Action; secondary?: Action } | null =
    item.status !== 'NEEDS_INPUT' && !isFailed(item.status) && item.status !== 'CANCELLED' ? null
      : item.errorCode === 'SERVER_NOT_PAIRED' ? { primary: { title: 'Connect server', icon: 'qr-code-outline', onPress: () => navigation.navigate('ConnectServer') }, secondary: importT }
        : isFailed(item.status) || item.status === 'CANCELLED' ? { primary: retryA, secondary: importT }
          : { primary: importT, secondary: connection && isVideo ? { ...retryA, title: 'Try server again' } : undefined };

  const textTab = ordered.length > 0;
  const syncLabel = item.syncStatus === 'pending' ? 'Not synced yet' : item.syncStatus === 'conflicted' ? 'Sync conflict' : item.syncStatus === 'failed' ? 'Sync failed' : null;
  const meta = [item.author, formatLocal(item.capturedAt, tz, { dateStyle: 'medium', timeStyle: 'short' }), item.language !== 'und' ? languageName(item.language) : '', item.origin === 'superbrain' ? 'Imported' : ''].filter(Boolean).join(' · ');
  const showFocus = (term: string | null) => {
    setFocus(term);
    if (term) setTab('text');
  };
  const shownMoments = allMoments ? moments : moments.slice(0, 4);

  const noText = (
    <Section title="Transcript">
      <Card>
        <T v="subtitle">No transcript yet</T>
        <T v="small" color="textMuted" style={{ marginTop: 4 }}>
          {item.status === 'TRANSCRIBING' ? 'Your server is transcribing this video.' : 'Qivra never invents a transcript. Import captions or a transcript, or let your server transcribe it.'}
        </T>
        {item.metadata?.description && isVideo ? <HighlightedText text={item.metadata.description} terms={terms} style={{ fontSize: 14, marginTop: space.sm }} selectable /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
          <Button kind="outline" title="Import transcript" onPress={() => navigation.navigate('TranscriptImport', { itemId: id })} />
          {connection && isVideo ? <Button kind="outline" title="Transcribe on server" onPress={() => void serverAction('transcribe_url')} /> : null}
          {!isVideo ? <Button kind="outline" title="Attach audio/video" onPress={() => void run(() => pickMediaFile(id))} /> : null}
          {d.media.length && connection ? <Button kind="outline" title="Transcribe attached file" onPress={() => void serverAction('transcribe')} /> : null}
        </View>
      </Card>
    </Section>
  );

  const summaryTab = (
    <>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <T v="subtitle" style={{ flex: 1 }}>TL;DR</T>
          {item.summary || ai?.enabled ? (
            <IconButton icon="sparkles-outline" size={18} label="Regenerate" onPress={() => void run(async () => {
              if (!ai?.enabled) return Alert.alert('No AI model configured', 'Add a model in Settings → AI models. The current summary was extracted from the source on this phone.');
              if (generating) return;
              await requestModelEnrichment(id);
            })} />
          ) : null}
          <IconButton icon="create-outline" size={18} label="Correct summary" onPress={() => startEdit('summary')} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {item.summary ? <Provenance origin={item.summaryOrigin} /> : null}
          {generating ? <Provenance origin="generating" /> : null}
        </View>
        {item.summary ? (
          <Pressable onLongPress={() => setPicked({ text: item.summary, startMs: null, source: 'summary' })} accessibilityHint="Long press to save as a highlight or copy">
            <HighlightedText text={item.summary} terms={terms} style={{ marginTop: space.sm }} />
          </Pressable>
        ) : (
          <T color="textFaint" style={{ marginTop: space.sm }}>{isPending(item.status) || item.status === 'TRANSCRIBING' ? 'The summary appears once the transcript is ready.' : 'No summary yet — there is no text to summarise.'}</T>
        )}
      </Card>

      {moments.length ? (
        <Section title="Key moments">
          {shownMoments.map((k, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md, marginBottom: space.sm }}>
              {k.startMs !== null ? (
                <TimestampPill label={formatTimestamp(k.startMs)} onPress={ytId ? () => openAt(k.startMs) : undefined} />
              ) : (
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent, marginTop: 8, marginRight: 4 }} />
              )}
              <Pressable style={{ flex: 1 }} onLongPress={() => setPicked({ text: k.text, startMs: k.startMs, source: 'moment' })} accessibilityHint="Long press to save as a highlight or copy">
                <HighlightedText text={k.text} terms={terms} style={{ fontSize: 14 }} />
              </Pressable>
            </View>
          ))}
          {moments.length > 4 ? <Button kind="text" title={allMoments ? 'Show fewer' : `Show all (${moments.length})`} onPress={() => setAllMoments(!allMoments)} style={{ alignSelf: 'flex-start' }} /> : null}
        </Section>
      ) : null}

      {highlights.data?.length ? (
        <Section title="Your highlights">
          {highlights.data.map((h) => (
            <View key={h.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginBottom: space.sm, paddingLeft: space.md, borderLeftWidth: 3, borderLeftColor: c.tint.orange }}>
              <View style={{ flex: 1 }}>
                <T v="small" selectable>{h.text}</T>
                {h.startMs !== null ? <View style={{ marginTop: 4, alignSelf: 'flex-start' }}><TimestampPill label={formatTimestamp(h.startMs)} onPress={ytId ? () => openAt(h.startMs) : undefined} /></View> : null}
              </View>
              <IconButton icon="close" size={16} label="Remove highlight" onPress={() => void run(() => repoOp((r) => r.deleteHighlight(h.id)))} />
            </View>
          ))}
        </Section>
      ) : null}

      {/* Keywords: tapping one opens the text filtered to it */}
      {keywords.length && textTab ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.md, marginHorizontal: -space.lg }} contentContainerStyle={{ paddingHorizontal: space.lg }}>
          {keywords.map((k) => (
            <Chip key={k.term} label={k.term} tone={k.isTool ? 'accent' : 'neutral'} selected={focus === k.term} onPress={() => showFocus(focus === k.term ? null : k.term)} />
          ))}
        </ScrollView>
      ) : null}

      {!textTab ? noText : null}

      {/* Related by meaning (local embeddings); falls back to shared tags when no embedding model is available. */}
      {similar.data?.length ? (
        <Section title="Related">
          {similar.data.some((r) => r.nearDuplicate) ? (
            <Banner tone="info" icon="copy-outline" title="You may have saved this already" body="A very similar item is in your library (marked below)." />
          ) : null}
          {similar.data.map((r) => (
            <View key={r.item.id}>
              {r.nearDuplicate ? <Chip label="Very similar" tone="info" icon="copy-outline" /> : null}
              <ItemCard item={r.item} timezone={tz} onPress={() => navigation.push('ItemDetail', { id: r.item.id })} />
            </View>
          ))}
        </Section>
      ) : d.related.length ? (
        <Section title="Related">
          {d.related.map((r) => <ItemCard key={r.id} item={r} timezone={tz} onPress={() => navigation.push('ItemDetail', { id: r.id })} />)}
        </Section>
      ) : null}
    </>
  );

  const transcriptTab = activeT ? (
    <>
      {ordered.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.lg }} contentContainerStyle={{ paddingHorizontal: space.lg }}>
          {ordered.map((t) => (
            <Chip key={t.id} label={textKindLabel(t.source) ?? `${languageName(t.language)}${t.kind === 'translation' ? ' · translation' : ''}`} selected={activeT.id === t.id} onPress={() => setTranscriptId(t.id)} />
          ))}
        </ScrollView>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.xs }}>
        <T v="caption" color="textFaint" style={{ flex: 1 }} numberOfLines={2}>
          {activeT.provider ?? activeT.source} · {activeT.origin === 'server' ? 'from your server' : 'on this phone'}{activeT.language === 'und' ? '' : ` · ${languageName(activeT.language)} (${activeT.languageMethod === 'user' ? 'set by you' : activeT.languageMethod === 'provider' ? 'reported by source' : 'detected'})`}{activeT.hasTimestamps ? '' : ' · no timestamps'}{activeT.corrected ? ' · corrected' : ''}
        </T>
        <IconButton icon="language-outline" size={19} label="Language" onPress={() => setLangOpen(true)} />
        <IconButton icon="copy-outline" size={19} label="Copy" onPress={() => void Clipboard.setStringAsync(activeT.text).then(() => Alert.alert('Copied', 'Transcript copied.'))} />
        <IconButton icon="add" size={20} label="Add translation" onPress={() => navigation.navigate('TranscriptImport', { itemId: id, kind: 'translation' })} />
      </View>
      {item.metadata?.description && isVideo ? (
        <Pressable onPress={() => setCaptionOpen(!captionOpen)} accessibilityRole="button" accessibilityHint={captionOpen ? 'Shows less' : 'Shows the whole caption'}>
          <Card style={{ padding: space.md, marginTop: space.sm }}>
            <T v="caption" color="textMuted">CAPTION</T>
            <HighlightedText text={item.metadata.description} terms={terms} numberOfLines={captionOpen ? undefined : 3} style={{ fontSize: 14, marginTop: 4 }} />
          </Card>
        </Pressable>
      ) : null}
      {focus ? <View style={{ flexDirection: 'row', marginTop: space.sm }}><Chip label={`Showing lines with “${focus}” ✕`} selected onPress={() => setFocus(null)} /></View> : null}
      {/* A GitHub README is Markdown: show it formatted (a keyword filter still lists matching lines). */}
      {activeT.format === 'md' && !focus ? (
        <Card style={{ padding: space.md, marginTop: space.sm }}><Markdown source={activeT.text} /></Card>
      ) : (
        <>
          <Card style={{ padding: space.md, marginTop: space.sm }}>
            {shownSegs.slice(0, 500).map((s) => (
              <View key={s.i} style={{ flexDirection: 'row', gap: space.md, paddingVertical: 6, paddingHorizontal: 4, borderRadius: radius.sm, backgroundColor: s.i === playingIndex ? c.accentSoft : 'transparent' }}
                accessibilityState={{ selected: s.i === playingIndex }}>
                {s.startMs !== null ? <TimestampPill label={formatTimestamp(s.startMs)} onPress={ytId ? () => openAt(s.startMs) : undefined} /> : null}
                <Pressable style={{ flex: 1 }} onLongPress={() => setPicked({ text: s.text, startMs: s.startMs, source: 'transcript', ordinal: isMd ? undefined : s.i })} accessibilityHint="Long press to save as a highlight, copy or correct this line">
                  <HighlightedText text={s.text} terms={focus ? [focus] : terms} style={{ fontSize: 15, lineHeight: 23 }} />
                </Pressable>
              </View>
            ))}
            {!shownSegs.length ? <T color="textMuted">No lines match.</T> : null}
          </Card>
          {shownSegs.length > 500 ? <T v="small" color="textMuted">Showing the first 500 lines.</T> : null}
          <T v="caption" color="textFaint" style={{ marginTop: space.sm }}>{ytId ? 'Tap a timestamp to play it here · ' : ''}Long-press a line to save it as a highlight or correct it.</T>
        </>
      )}
    </>
  ) : null;

  const detailsTab = (
    <View>
      <Section title="Your note" action={<IconButton icon="create-outline" label="Edit note" onPress={() => startEdit('note')} />}>
        {item.note ? <T selectable>{item.note}</T> : <T color="textFaint" onPress={() => startEdit('note')}>Add a note — why did you save this?</T>}
      </Section>

      <Section title="Tags & collections" action={<IconButton icon="pricetags-outline" label="Edit tags" onPress={() => startEdit('tags')} />}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {item.tags.length ? item.tags.map((t) => <Chip key={t} label={`#${t}`} />) : <T color="textFaint">No tags.</T>}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space.sm }}>
          {d.collections.map((col) => {
            const on = d.memberOf.includes(col.id);
            return <Chip key={col.id} label={col.name} selected={on} onPress={() => void run(() => repoOp((r) => (on ? r.removeFromCollection(col.id, [id]) : r.addToCollection(col.id, [id]))))} />;
          })}
          <Chip label="New collection" icon="add" onPress={() => navigation.navigate('Collections')} />
        </View>
      </Section>

      {e && (e.tools.length || e.repos.length || e.commands.length) ? (
        <Section title="Tools, repos & commands">
          {e.tools.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{e.tools.map((t) => <Chip key={t} label={t} tone="accent" onPress={textTab ? () => showFocus(t) : undefined} />)}</View> : null}
          {e.repos.map((r) => (
            <T key={r} v="small" color="accent" style={{ marginTop: 6, textDecorationLine: 'underline' }} onPress={() => void Linking.openURL(`https://github.com/${r}`)}>github.com/{r}</T>
          ))}
          {e.commands.map((cmd) => (
            <Card key={cmd.command} style={{ marginTop: space.sm, padding: space.md, backgroundColor: cmd.destructive ? c.dangerSoft : c.surface }}>
              <T v="mono" selectable>{cmd.command}</T>
              {cmd.destructive ? <T v="small" color="danger" style={{ marginTop: 4 }}>⚠ Potentially destructive: {cmd.reason}</T> : null}
              <Button kind="text" title="Copy" icon="copy-outline" onPress={() => void Clipboard.setStringAsync(cmd.command)} style={{ alignSelf: 'flex-start' }} />
            </Card>
          ))}
          <T v="caption" color="textFaint" style={{ marginTop: 4 }}>Copied verbatim from the source. Qivra never runs commands.</T>
        </Section>
      ) : null}

      {e?.actionItems.length ? (
        <Section title="Action items">{e.actionItems.map((a, i) => <T key={i} v="small" style={{ marginBottom: 4 }}>☐ {a}</T>)}</Section>
      ) : null}

      <Section title="Processing">
        {d.jobs.length ? d.jobs.map((j) => (
          <View key={j.id} style={{ paddingVertical: 4 }}>
            <T v="small">{j.kind.replace(/_/g, ' ')} — {j.status.replace(/_/g, ' ')}{j.attempts ? ` (attempt ${j.attempts})` : ''}</T>
            {j.lastError ? <T v="caption" color={j.status === 'failed_permanent' ? 'danger' : 'textMuted'}>{j.lastError}</T> : null}
          </View>
        )) : <T v="small" color="textMuted">No processing jobs.</T>}
        {e ? <T v="caption" color="textFaint">Summary source: {e.origin === 'local' ? 'extracted on this phone' : e.origin === 'model' ? 'AI model' : 'your server'} · {e.provider}</T> : null}
        {d.media.length ? <T v="caption" color="textFaint">Attached media: {d.media.map((m) => `${m.name} (${(m.size / 1048576).toFixed(1)} MB)`).join(', ')}</T> : null}
        <Button kind="text" title="Reprocess" icon="refresh" onPress={() => void retry()} style={{ alignSelf: 'flex-start' }} />
      </Section>
    </View>
  );

  const tabs: { key: 'summary' | 'text' | 'details'; label: string; count?: number }[] = [
    { key: 'summary', label: 'Summary' },
    ...(textTab ? [{ key: 'text' as const, label: contentLabel, count: activeT?.format === 'md' ? undefined : segs.data?.length || undefined }] : []),
    { key: 'details', label: 'Details' },
  ];
  const current = tab === 'text' && !textTab ? 'summary' : tab;

  return (
    <Screen padded={false} scrollRef={scrollRef}>
      <Header
        title=""
        onBack={() => navigation.goBack()}
        actions={<>
          <IconButton icon={item.favorite ? 'star' : 'star-outline'} color={item.favorite ? c.tint.yellow : undefined} label={item.favorite ? 'Remove from favourites' : 'Add to favourites'} onPress={() => void run(() => repoOp((r) => r.setFavorite([id], !item.favorite)))} />
          <IconButton icon={item.archived ? 'arrow-undo-outline' : 'archive-outline'} label={item.archived ? 'Restore from archive' : 'Archive'} onPress={() => void run(() => repoOp((r) => r.setArchived([id], !item.archived)))} />
          <IconButton icon="trash-outline" label="Delete item" color={c.danger} onPress={() => void del()} />
        </>}
      />
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.xxl }}>
        {/* Hero: YouTube plays in place; shared images show in place; other sources open the original */}
        {ytId ? (
          <YouTubeHero ref={heroRef} videoId={ytId} thumbnailUrl={item.thumbnailUrl || null} onTime={onTime} badge={<PlatformBadge source={item.sourceType} onMedia />} />
        ) : d.media.some((m) => m.mime.startsWith('image/')) ? (
          <ImageHero uris={d.media.filter((m) => m.mime.startsWith('image/')).reverse().map((m) => m.uri)} badge={<PlatformBadge source={item.sourceType} onMedia />} />
        ) : (
        <Pressable onPress={() => openAt(null)} disabled={!item.url} accessibilityRole="button" accessibilityLabel={isVideo ? 'Play on the original app' : 'Open original page'}
          style={{ borderRadius: radius.lg, overflow: 'hidden', backgroundColor: c.surfaceAlt, aspectRatio: item.thumbnailUrl ? 16 / 9 : undefined, minHeight: item.thumbnailUrl ? undefined : 96, justifyContent: 'center', alignItems: 'center' }}>
          {item.thumbnailUrl ? <Image source={{ uri: item.thumbnailUrl }} accessibilityIgnoresInvertColors style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" /> : (
            <Ionicons name={PLATFORM_ICONS[item.sourceType] ?? 'document-outline'} size={40} color={c.textMuted} />
          )}
          {isVideo && item.url ? (
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: c.scrim, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="play" size={28} color="#fff" style={{ marginLeft: 4 }} />
            </View>
          ) : null}
          <View style={{ position: 'absolute', top: space.sm, left: space.sm }}><PlatformBadge source={item.sourceType} onMedia={!!item.thumbnailUrl} /></View>
        </Pressable>
        )}

        {/* Compact header: title, one meta line, one row of actions */}
        <T v="title" style={{ marginTop: space.md }} numberOfLines={titleOpen ? undefined : 3} onPress={() => setTitleOpen(!titleOpen)} onLongPress={() => startEdit('title')} accessibilityHint="Tap to show the whole title; long press to edit it">{item.title || item.url || 'Untitled'}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
          <T v="caption" color="textMuted" style={{ flexShrink: 1 }}>{meta}</T>
          {syncLabel ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: meta ? 8 : 0 }} accessibilityLabel={syncLabel}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: item.syncStatus === 'pending' ? c.textFaint : c.danger }} />
              <T v="caption" color={item.syncStatus === 'pending' ? 'textMuted' : 'danger'}>{syncLabel}</T>
            </View>
          ) : null}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.md, marginHorizontal: -space.lg }} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, paddingVertical: 2 }}>
          <ActionPill primary icon="sparkles-outline" label="Ask" a11yLabel="Ask about this" onPress={() => navigation.navigate('Main', { screen: 'Agent', params: { itemId: id } })} />
          <ActionPill icon="layers-outline" label="Flashcards" a11yLabel="Make flashcards" count={cardCount.data || undefined} loading={cardAction.busy}
            onPress={() => void cardAction.run(async () => {
              const r = await makeCards(id);
              setCardsMsg(r.added
                ? `${r.added} card${r.added === 1 ? '' : 's'} made${r.origin === 'local' ? ' on this phone' : ''} · ${r.total} in total`
                : r.total ? `No new cards · ${r.total} already made` : (r.note ?? 'No cards could be made.'));
            }, 'Could not make flashcards')} />
          {cardCount.data ? <ActionPill icon="school-outline" label="Review" onPress={() => navigation.navigate('Review')} /> : null}
          <ActionPill icon={item.remindAt ? 'notifications' : 'notifications-outline'} label={item.remindAt ? formatReminder(item.remindAt, new Date()) : 'Remind'} a11yLabel={item.remindAt ? `Reminder set for ${formatReminder(item.remindAt, new Date())}` : 'Remind me to revisit'} onPress={() => setRemindOpen(true)} />
          {item.url ? <ActionPill icon="open-outline" label="Open" a11yLabel="Open original" onPress={() => void Linking.openURL(item.url!)} /> : null}
        </ScrollView>
        {cardsMsg ? <T v="caption" color="textMuted" accessibilityLiveRegion="polite" style={{ marginTop: space.xs }}>{cardsMsg}</T> : null}

        {item.status !== 'READY' ? <ProgressSteps steps={stepsFor(item, speech.length > 0, articles.length > 0, isVideo)} /> : null}

        {item.status === 'TRANSCRIBING' ? (
          <Banner tone="info" icon="hourglass-outline" title="Transcribing" body={`${item.errorMessage ?? 'Working on the transcript…'} You can leave this page — it continues in the background.`} action={<Button kind="outline" title="Cancel" onPress={() => void run(() => cancelItemProcessing(id))} />} />
        ) : isPending(item.status) ? (
          <Banner tone="info" icon="sync-outline" title={STATUS_LABELS[item.status]} body="Processing on this phone…" />
        ) : null}
        {info && item.status === 'READY' ? <Banner tone="info" title={item.errorCode === 'INFO_UNREADABLE' ? 'Page could not be read' : 'No speech to transcribe'} body={item.errorMessage ?? undefined} /> : null}
        {problem ? (
          <Banner
            tone={isFailed(item.status) ? 'danger' : 'warning'}
            title={item.errorCode === 'SERVER_NOT_PAIRED' ? 'Connect your server to transcribe' : STATUS_LABELS[item.status]}
            body={item.errorMessage ?? undefined}
            action={<>
              <Button title={problem.primary.title} icon={problem.primary.icon} onPress={problem.primary.onPress} />
              {problem.secondary ? <Button kind="outline" title={problem.secondary.title} icon={problem.secondary.icon} onPress={problem.secondary.onPress} /> : null}
            </>}
          />
        ) : null}
        {item.syncStatus === 'conflicted' ? <Banner tone="warning" title="Edited on another device" action={<Button kind="outline" title="Resolve" onPress={() => navigation.navigate('Conflicts')} />} /> : null}

        <View style={{ marginTop: space.lg, marginBottom: space.md }}>
          <Segmented options={tabs} value={current} onChange={setTab} />
        </View>
        {current === 'summary' ? summaryTab : current === 'text' ? transcriptTab : detailsTab}
      </View>

      <Sheet visible={!!edit} onClose={() => setEdit(null)} title={edit === 'tags' ? 'Edit tags' : `Edit ${edit}`}>
        <Field label={edit === 'tags' ? 'Comma-separated tags' : edit ?? ''} value={draft} onChangeText={setDraft} multiline={edit !== 'title' && edit !== 'tags'} autoFocus />
        {edit === 'summary' ? <T v="small" color="textMuted">Your correction replaces the generated summary and is marked as your edit.</T> : null}
        <Button title="Save" onPress={() => void saveEdit()} loading={busy} style={{ marginTop: space.md }} />
      </Sheet>
      <Sheet visible={langOpen} onClose={() => setLangOpen(false)} title="Transcript language">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {LANGUAGES.map((l) => (
            <Chip key={l.code} label={l.name} selected={activeT?.language === l.code} onPress={() => void run(async () => { if (activeT) await repoOp((r) => r.setTranscriptLanguage(activeT.id, l.code)); setLangOpen(false); })} />
          ))}
        </View>
      </Sheet>
      <Sheet visible={!!picked} onClose={() => setPicked(null)} title={picked?.source === 'transcript' ? 'This line' : picked?.source === 'summary' ? 'Summary' : 'Key moment'}>
        <T v="small" color="textMuted" numberOfLines={4} style={{ marginBottom: space.md }}>{picked?.startMs != null ? `${formatTimestamp(picked.startMs)} · ` : ''}{picked?.text}</T>
        <Button title="Save highlight" icon="bookmark-outline" onPress={() => void saveHighlight()} />
        <Button kind="outline" title="Copy" icon="copy-outline" style={{ marginTop: space.sm }} onPress={() => void Clipboard.setStringAsync(picked?.text ?? '').then(() => setPicked(null))} />
        {picked?.ordinal !== undefined ? (
          <Button kind="outline" title="Correct line" icon="create-outline" style={{ marginTop: space.sm }} onPress={() => { setCorrecting({ ordinal: picked.ordinal!, text: picked.text }); setPicked(null); }} />
        ) : null}
      </Sheet>
      <Sheet visible={remindOpen} onClose={() => { setRemindOpen(false); setCustom(null); }} title="Remind me to revisit">
        {reminderPresets(new Date()).map((p) => (
          <Row key={p.key} icon="alarm-outline" tint={c.tint.orange} title={p.label} value={formatReminder(p.at.toISOString(), new Date())} onPress={() => void remind(p.at)} />
        ))}
        <View style={{ marginTop: space.md }}>
          <T v="caption" color="textMuted">Custom</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs }}>
            <IconButton icon="remove" label="One day earlier" onPress={() => setCustom((d) => new Date((d ?? defaultCustom()).getTime() - 86_400_000))} />
            <IconButton icon="add" label="One day later" onPress={() => setCustom((d) => new Date((d ?? defaultCustom()).getTime() + 86_400_000))} />
            <T style={{ flex: 1, textAlign: 'center', fontWeight: '600' }}>{formatReminder((custom ?? defaultCustom()).toISOString(), new Date())}</T>
            <IconButton icon="chevron-down" label="One hour earlier" onPress={() => setCustom((d) => new Date((d ?? defaultCustom()).getTime() - 3_600_000))} />
            <IconButton icon="chevron-up" label="One hour later" onPress={() => setCustom((d) => new Date((d ?? defaultCustom()).getTime() + 3_600_000))} />
          </View>
          <Button title="Set reminder" icon="notifications-outline" style={{ marginTop: space.sm }} disabled={(custom ?? defaultCustom()).getTime() <= Date.now()} onPress={() => void remind(custom ?? defaultCustom())} />
        </View>
        {item.remindAt ? <Button kind="text" title="Remove reminder" icon="close" style={{ marginTop: space.sm }} onPress={() => void run(async () => { await clearItemReminders([id]); setRemindOpen(false); })} /> : null}
      </Sheet>
      <Sheet visible={!!correcting} onClose={() => setCorrecting(null)} title="Correct this line">
        <Field label="Text" value={correcting?.text ?? ''} onChangeText={(t) => setCorrecting((x) => (x ? { ...x, text: t } : x))} multiline />
        <Button title="Save correction" onPress={() => void run(async () => {
          if (!activeT || !correcting) return;
          const next = (segs.data ?? []).map((s, i) => (i === correcting.ordinal ? { ...s, text: correcting.text.trim() || s.text } : s));
          await repoOp((r) => r.correctTranscript(activeT.id, next));
          setCorrecting(null);
          await schedulePipeline(id);
        })} />
      </Sheet>
    </Screen>
  );
}
