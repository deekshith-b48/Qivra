import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Image, Linking, Pressable, View } from 'react-native';
import { formatLocal } from '../core/dates';
import { extractKeywords, type Keyword } from '../core/highlights';
import { languageName, LANGUAGES } from '../core/language';
import { isFailed, isPending, STATUS_LABELS } from '../core/status';
import { formatTimestamp, type Segment } from '../core/transcripts';
import { analyzeUrl, ARTICLE_SOURCES, VIDEO_SOURCES } from '../core/url';
import type { Item, Transcript } from '../db/types';
import type { RootProps } from '../navigation/types';
import { deleteItemFiles, pickMediaFile } from '../services/capture';
import { getRepo } from '../services/db';
import { emit } from '../services/events';
import { cancelItemProcessing, requestModelEnrichment, requestServerProcessing, schedulePipeline } from '../services/processing';
import { Banner, Button, Card, Chip, Field, Header, IconButton, Loading, Provenance, Screen, Section, Sheet, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { ItemCard, SyncChip } from '../ui/ItemCard';
import { HighlightedText, PlatformBadge, PLATFORM_ICONS, ProgressSteps, Segmented, TimestampPill, type StepState } from '../ui/media';
import { radius, space, useTheme } from '../ui/theme';
import { useConnection, useSettings } from '../ui/useSettings';

type Tab = 'summary' | 'transcript' | 'highlights';

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

export default function ItemDetailScreen({ navigation, route }: RootProps<'ItemDetail'>) {
  const { id } = route.params;
  const { c } = useTheme();
  const settings = useSettings();
  const { connection } = useConnection();
  const tz = settings?.timezone ?? 'UTC';
  const { busy, run } = useAction();
  const [tab, setTab] = useState<Tab>('summary');
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [edit, setEdit] = useState<null | 'title' | 'note' | 'summary' | 'tags'>(null);
  const [draft, setDraft] = useState('');
  const [langOpen, setLangOpen] = useState(false);
  const [correcting, setCorrecting] = useState<{ ordinal: number; text: string } | null>(null);
  const [details, setDetails] = useState(false);

  const q = useQuery(async (repo) => {
    const item = await repo.getItem(id);
    if (!item || item.deleted) return null;
    return {
      item,
      transcripts: await repo.listTranscripts(id),
      jobs: await repo.listJobs({ itemId: id, limit: 10 }),
      media: await repo.listMedia(id),
      collections: await repo.listCollections(),
      memberOf: await repo.itemCollectionIds(id),
      related: await repo.relatedItems(item, 4),
    };
  }, ['items', 'jobs', 'collections'], [id]);

  useEffect(() => {
    void (async () => (await getRepo()).markViewed(id))();
  }, [id]);

  const d = q.data;
  const speech = d?.transcripts.filter((t) => !ARTICLE_SOURCES.has(t.source)) ?? [];
  const articles = d?.transcripts.filter((t) => ARTICLE_SOURCES.has(t.source)) ?? [];
  const ordered: Transcript[] = [...speech, ...articles];
  const activeT = ordered.find((t) => t.id === transcriptId) ?? ordered[0] ?? null;
  const segs = useQuery(async (repo) => (activeT ? repo.getSegments(activeT.id) : []), ['items'], [activeT?.id, activeT?.updatedAt]);

  const keywords: Keyword[] = useMemo(() => {
    if (!d) return [];
    const base: Segment[] = segs.data?.length ? segs.data : [{ startMs: null, endMs: null, text: [d.item.summary, d.item.note, d.item.metadata?.description ?? ''].join(' ') }];
    return extractKeywords(base, { tools: d.item.enrichment?.tools ?? [], title: d.item.title, max: 12 });
  }, [d, segs.data]);
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
  const contentLabel = activeT && ARTICLE_SOURCES.has(activeT.source) ? (activeT.source === 'github_readme' ? 'README' : 'Article') : 'Transcript';

  const repoOp = async (fn: (repo: Awaited<ReturnType<typeof getRepo>>) => Promise<unknown>) => {
    await fn(await getRepo());
    emit('items');
  };
  const openAt = (ms: number | null) => {
    if (!item.url) return;
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
  const serverAction = (kind: 'captions' | 'transcribe' | 'enrich' | 'transcribe_url') => run(async () => {
    const what = { captions: 'fetch published captions for this video', transcribe: 'upload the attached media file and transcribe it', enrich: 'send this item and its transcript for AI enrichment', transcribe_url: 'download this post’s audio and transcribe it' }[kind];
    if (!(await confirm('Use your server?', `Qivra will ${what} on ${connection?.serverUrl}.`, 'Continue'))) return;
    await requestServerProcessing(id, kind);
  });
  const del = () => run(async () => {
    if (!(await confirm('Delete this item?', 'Its transcripts, notes and attached media on this phone will be deleted.', 'Delete', true))) return;
    await deleteItemFiles([id]);
    await repoOp((repo) => repo.deleteItems([id]));
    navigation.goBack();
  });

  const shownSegs = (segs.data ?? []).map((s, i) => ({ ...s, i })).filter((s) => !focus || s.text.toLowerCase().includes(focus.toLowerCase()));
  const info = item.errorCode?.startsWith('INFO_');

  return (
    <Screen padded={false}>
      <Header
        title=""
        onBack={() => navigation.goBack()}
        actions={<>
          {item.url ? <IconButton icon="open-outline" label="Open original" onPress={() => void Linking.openURL(item.url!)} /> : null}
          <IconButton icon={item.archived ? 'arrow-undo-outline' : 'archive-outline'} label={item.archived ? 'Restore from archive' : 'Archive'} onPress={() => void run(() => repoOp((r) => r.setArchived([id], !item.archived)))} />
          <IconButton icon="trash-outline" label="Delete item" color={c.danger} onPress={() => void del()} />
        </>}
      />
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.xxl }}>
        {/* Hero */}
        <Pressable onPress={() => openAt(null)} disabled={!item.url} accessibilityRole="button" accessibilityLabel={isVideo ? 'Play on the original app' : 'Open original page'}
          style={{ borderRadius: radius.lg, overflow: 'hidden', backgroundColor: c.surfaceAlt, aspectRatio: item.thumbnailUrl ? 16 / 9 : undefined, minHeight: item.thumbnailUrl ? undefined : 120, justifyContent: 'center', alignItems: 'center' }}>
          {item.thumbnailUrl ? <Image source={{ uri: item.thumbnailUrl }} accessibilityIgnoresInvertColors style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" /> : (
            <Ionicons name={PLATFORM_ICONS[item.sourceType] ?? 'document-outline'} size={44} color={c.textMuted} />
          )}
          {isVideo && item.url ? (
            <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="play" size={30} color="#fff" style={{ marginLeft: 4 }} />
            </View>
          ) : null}
          <View style={{ position: 'absolute', top: space.sm, left: space.sm }}><PlatformBadge source={item.sourceType} onMedia={!!item.thumbnailUrl} /></View>
        </Pressable>

        <T v="display" style={{ marginTop: space.md }} onLongPress={() => startEdit('title')} accessibilityHint="Long press to edit the title">{item.title || item.url || 'Untitled'}</T>
        <T v="small" color="textMuted" style={{ marginTop: 4 }}>
          {[item.author, formatLocal(item.capturedAt, tz, { dateStyle: 'medium', timeStyle: 'short' }), item.language !== 'und' ? languageName(item.language) : ''].filter(Boolean).join(' · ')}
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space.sm }}>
          <SyncChip status={item.syncStatus} />
          {item.origin === 'superbrain' ? <Chip label="From SuperBrain" tone="info" /> : null}
        </View>

        <ProgressSteps steps={stepsFor(item, speech.length > 0, articles.length > 0, isVideo)} />

        {item.status === 'TRANSCRIBING' ? (
          <Banner tone="info" icon="hourglass-outline" title="Transcribing" body={`${item.errorMessage ?? 'Working on the transcript…'} You can leave this page — it continues in the background.`} action={<Button kind="outline" title="Cancel" onPress={() => void run(() => cancelItemProcessing(id))} />} />
        ) : isPending(item.status) ? (
          <Banner tone="info" icon="sync-outline" title={STATUS_LABELS[item.status]} body="Processing on this phone…" />
        ) : null}
        {info && item.status === 'READY' ? <Banner tone="info" title={item.errorCode === 'INFO_UNREADABLE' ? 'Page could not be read' : 'No speech to transcribe'} body={item.errorMessage ?? undefined} /> : null}
        {item.status === 'NEEDS_INPUT' || isFailed(item.status) || item.status === 'CANCELLED' ? (
          <Banner
            tone={isFailed(item.status) ? 'danger' : 'warning'}
            title={item.errorCode === 'SERVER_NOT_PAIRED' ? 'Connect your server to transcribe' : STATUS_LABELS[item.status]}
            body={item.errorMessage ?? undefined}
            action={<>
              {item.errorCode === 'SERVER_NOT_PAIRED' ? <Button kind="outline" title="Connect server" icon="qr-code-outline" onPress={() => navigation.navigate('ConnectServer')} /> : null}
              <Button kind="outline" title="Import transcript" icon="document-text-outline" onPress={() => navigation.navigate('TranscriptImport', { itemId: id })} />
              {connection && isVideo && item.errorCode !== 'SERVER_NOT_PAIRED' ? <Button kind="outline" title="Try server again" icon="refresh" onPress={() => void retry()} /> : null}
              {isFailed(item.status) || item.status === 'CANCELLED' ? <Button kind="outline" title="Retry" icon="refresh" onPress={() => void retry()} /> : null}
            </>}
          />
        ) : null}
        {item.syncStatus === 'conflicted' ? <Banner tone="warning" title="Edited on another device" action={<Button kind="outline" title="Resolve" onPress={() => navigation.navigate('Conflicts')} />} /> : null}

        <View style={{ marginTop: space.md }}>
          <Segmented<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { key: 'summary', label: 'Summary' },
              { key: 'transcript', label: isVideo || !activeT ? 'Transcript' : contentLabel, count: segs.data?.length || undefined },
              { key: 'highlights', label: 'Highlights', count: keywords.length || undefined },
            ]}
          />
        </View>

        {tab === 'summary' ? (
          <View>
            <Section title="Summary" action={<IconButton icon="create-outline" label="Correct summary" onPress={() => startEdit('summary')} />}>
              {item.summary ? (
                <Card>
                  <Provenance origin={item.summaryOrigin} />
                  <HighlightedText text={item.summary} terms={terms} style={{ marginTop: space.sm }} selectable />
                </Card>
              ) : <T color="textFaint">{isPending(item.status) || item.status === 'TRANSCRIBING' ? 'The summary appears once the transcript is ready.' : 'No summary yet — there is no text to summarise.'}</T>}
              {e?.keyPoints.length ? (
                <View style={{ marginTop: space.md }}>
                  <T v="caption" color="textMuted">KEY POINTS</T>
                  {e.keyPoints.map((k, i) => (
                    <View key={i} style={{ flexDirection: 'row', marginTop: 6 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent, marginTop: 8, marginRight: 10 }} />
                      <HighlightedText text={k} terms={terms} style={{ flex: 1, fontSize: 14 }} />
                    </View>
                  ))}
                </View>
              ) : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
                <Button kind="tonal" title="Rewrite with AI" icon="sparkles-outline" onPress={() => void run(async () => {
                  if (!settings?.ai.enabled) return Alert.alert('No AI model configured', 'Add a model in Settings → AI models. The current summary was extracted from the source on this phone.');
                  await requestModelEnrichment(id);
                })} loading={busy} />
                {connection ? <Button kind="outline" title="Enrich on server" icon="server-outline" onPress={() => void serverAction('enrich')} /> : null}
              </View>
            </Section>

            {item.metadata?.description && isVideo ? (
              <Section title="Caption">
                <HighlightedText text={item.metadata.description} terms={terms} style={{ fontSize: 14 }} selectable />
              </Section>
            ) : null}

            <Section title="Your note" action={<IconButton icon="create-outline" label="Edit note" onPress={() => startEdit('note')} />}>
              {item.note ? <T selectable>{item.note}</T> : <T color="textFaint" onPress={() => startEdit('note')}>Add a note — why did you save this?</T>}
            </Section>

            {e && (e.tools.length || e.repos.length || e.commands.length) ? (
              <Section title="Tools, repos & commands">
                {e.tools.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{e.tools.map((t) => <Chip key={t} label={t} tone="accent" onPress={() => { setFocus(t); setTab('highlights'); }} />)}</View> : null}
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
          </View>
        ) : null}

        {tab === 'transcript' ? (
          <View style={{ marginTop: space.md }}>
            {ordered.length ? (
              <>
                {ordered.length > 1 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                    {ordered.map((t) => (
                      <Chip key={t.id} label={ARTICLE_SOURCES.has(t.source) ? (t.source === 'github_readme' ? 'README' : 'Article') : `${languageName(t.language)}${t.kind === 'translation' ? ' · translation' : ''}`} selected={activeT?.id === t.id} onPress={() => setTranscriptId(t.id)} />
                    ))}
                  </View>
                ) : null}
                {activeT ? (
                  <>
                    <T v="caption" color="textFaint">
                      {activeT.provider ?? activeT.source} · {activeT.origin === 'server' ? 'from your server' : 'on this phone'} · {languageName(activeT.language)} ({activeT.languageMethod === 'user' ? 'set by you' : activeT.languageMethod === 'provider' ? 'reported by source' : 'detected'}){activeT.hasTimestamps ? '' : ' · no timestamps in source'}{activeT.corrected ? ' · corrected' : ''}
                    </T>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginVertical: space.sm }}>
                      <Button kind="outline" title="Language" icon="language-outline" onPress={() => setLangOpen(true)} />
                      <Button kind="outline" title="Copy" icon="copy-outline" onPress={() => void Clipboard.setStringAsync(activeT.text).then(() => Alert.alert('Copied', 'Transcript copied.'))} />
                      <Button kind="outline" title="Add translation" icon="add" onPress={() => navigation.navigate('TranscriptImport', { itemId: id, kind: 'translation' })} />
                    </View>
                    {focus ? <Chip label={`Showing lines with “${focus}” ✕`} selected onPress={() => setFocus(null)} /> : null}
                    <Card style={{ padding: space.md }}>
                      {shownSegs.slice(0, 500).map((s) => (
                        <View key={s.i} style={{ flexDirection: 'row', gap: space.md, paddingVertical: 6 }}>
                          {s.startMs !== null ? <TimestampPill label={formatTimestamp(s.startMs)} onPress={ytId ? () => openAt(s.startMs) : undefined} /> : null}
                          <Pressable style={{ flex: 1 }} onLongPress={() => setCorrecting({ ordinal: s.i, text: s.text })} accessibilityHint="Long press to correct this line">
                            <HighlightedText text={s.text} terms={focus ? [focus] : terms} style={{ fontSize: 15, lineHeight: 23 }} />
                          </Pressable>
                        </View>
                      ))}
                      {!shownSegs.length ? <T color="textMuted">No lines match.</T> : null}
                    </Card>
                    {shownSegs.length > 500 ? <T v="small" color="textMuted">Showing the first 500 lines.</T> : null}
                    <T v="caption" color="textFaint" style={{ marginTop: space.sm }}>{ytId ? 'Tap a timestamp to play from there · ' : ''}Long-press a line to correct it.</T>
                  </>
                ) : null}
              </>
            ) : (
              <Card>
                <T v="subtitle">No transcript yet</T>
                <T v="small" color="textMuted" style={{ marginTop: 4 }}>
                  {item.status === 'TRANSCRIBING' ? 'Your server is transcribing this video.' : 'Qivra never invents a transcript. Import captions or a transcript, or let your server transcribe it.'}
                </T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
                  <Button kind="outline" title="Import transcript" onPress={() => navigation.navigate('TranscriptImport', { itemId: id })} />
                  {connection && isVideo ? <Button kind="outline" title="Transcribe on server" onPress={() => void serverAction('transcribe_url')} /> : null}
                  {!isVideo ? <Button kind="outline" title="Attach audio/video" onPress={() => void run(() => pickMediaFile(id))} /> : null}
                  {d.media.length && connection ? <Button kind="outline" title="Transcribe attached file" onPress={() => void serverAction('transcribe')} /> : null}
                </View>
              </Card>
            )}
          </View>
        ) : null}

        {tab === 'highlights' ? (
          <View style={{ marginTop: space.md }}>
            {keywords.length ? (
              <>
                <T v="small" color="textMuted">The words that matter most here{segs.data?.some((s) => s.startMs !== null) ? ', with the moments they come up' : ''}. Tap one to focus.</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space.sm }}>
                  {keywords.map((k) => <Chip key={k.term} label={`${k.term} · ${k.count}`} tone={k.isTool ? 'accent' : 'neutral'} selected={focus === k.term} onPress={() => setFocus(focus === k.term ? null : k.term)} />)}
                </View>
                {keywords.filter((k) => !focus || k.term === focus).slice(0, focus ? 1 : 6).map((k) => (
                  <Card key={k.term} style={{ marginTop: space.md }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <T v="subtitle" style={{ flex: 1 }}>{k.term}</T>
                      <T v="caption" color="textMuted">{k.count}× {k.isTool ? '· tool' : ''}</T>
                    </View>
                    {k.moments.map((m, i) => (
                      <View key={i} style={{ flexDirection: 'row', gap: space.md, marginTop: space.sm }}>
                        {m.startMs !== null ? <TimestampPill label={formatTimestamp(m.startMs)} onPress={ytId ? () => openAt(m.startMs) : undefined} /> : null}
                        <HighlightedText text={m.text} terms={[k.term]} style={{ flex: 1, fontSize: 14 }} />
                      </View>
                    ))}
                    <Button kind="text" title="Show in transcript" icon="arrow-forward" onPress={() => { setFocus(k.term); setTab('transcript'); }} style={{ alignSelf: 'flex-start' }} />
                  </Card>
                ))}
                {e?.timestamps.length ? (
                  <Section title="Key moments">
                    {e.timestamps.map((t, i) => (
                      <View key={i} style={{ flexDirection: 'row', gap: space.md, marginBottom: space.sm }}>
                        <TimestampPill label={formatTimestamp(t.ms)} onPress={ytId ? () => openAt(t.ms) : undefined} />
                        <HighlightedText text={t.label} terms={terms} style={{ flex: 1, fontSize: 14 }} />
                      </View>
                    ))}
                  </Section>
                ) : null}
              </>
            ) : <Card><T color="textMuted">Highlights appear once there is a transcript or article text.</T></Card>}
          </View>
        ) : null}

        <Pressable onPress={() => setDetails(!details)} accessibilityRole="button" accessibilityState={{ expanded: details }} style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.xl, minHeight: 48 }}>
          <T v="subtitle" style={{ flex: 1 }}>Processing details</T>
          <Ionicons name={details ? 'chevron-up' : 'chevron-down'} size={18} color={c.textMuted} />
        </Pressable>
        {details ? (
          <View>
            {d.jobs.length ? d.jobs.map((j) => (
              <View key={j.id} style={{ paddingVertical: 4 }}>
                <T v="small">{j.kind.replace(/_/g, ' ')} — {j.status.replace(/_/g, ' ')}{j.attempts ? ` (attempt ${j.attempts})` : ''}</T>
                {j.lastError ? <T v="caption" color={j.status === 'failed_permanent' ? 'danger' : 'textMuted'}>{j.lastError}</T> : null}
              </View>
            )) : <T v="small" color="textMuted">No processing jobs.</T>}
            {e ? <T v="caption" color="textFaint">Summary source: {e.origin === 'local' ? 'extracted on this phone' : e.origin === 'model' ? 'AI model' : 'your server'} · {e.provider}</T> : null}
            {d.media.length ? <T v="caption" color="textFaint">Attached media: {d.media.map((m) => `${m.name} (${(m.size / 1048576).toFixed(1)} MB)`).join(', ')}</T> : null}
            <Button kind="text" title="Reprocess" icon="refresh" onPress={() => void retry()} style={{ alignSelf: 'flex-start' }} />
          </View>
        ) : null}

        {d.related.length ? (
          <Section title="Related">
            {d.related.map((r) => <ItemCard key={r.id} item={r} timezone={tz} onPress={() => navigation.push('ItemDetail', { id: r.id })} />)}
          </Section>
        ) : null}
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
