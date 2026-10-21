import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useState } from 'react';
import { Alert, Image, Linking, View } from 'react-native';
import { formatLocal } from '../core/dates';
import { languageName, LANGUAGES } from '../core/language';
import { isFailed, isPending, STATUS_LABELS } from '../core/status';
import { formatTimestamp } from '../core/transcripts';
import { SOURCE_LABELS } from '../core/url';
import type { RootProps } from '../navigation/types';
import { deleteItemFiles, pickMediaFile } from '../services/capture';
import { emit } from '../services/events';
import { cancelItemProcessing, requestModelEnrichment, requestServerProcessing, schedulePipeline } from '../services/processing';
import { Banner, Button, Card, Chip, Divider, Field, Header, IconButton, Loading, Provenance, Screen, Section, Sheet, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { ItemCard, StatusChip, SyncChip } from '../ui/ItemCard';
import { space, useTheme } from '../ui/theme';
import { useConnection, useSettings } from '../ui/useSettings';

export default function ItemDetailScreen({ navigation, route }: RootProps<'ItemDetail'>) {
  const { id } = route.params;
  const { c } = useTheme();
  const settings = useSettings();
  const { connection } = useConnection();
  const tz = settings?.timezone ?? 'UTC';
  const { busy, run } = useAction();
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [edit, setEdit] = useState<null | 'title' | 'note' | 'summary' | 'tags'>(null);
  const [draft, setDraft] = useState('');
  const [langOpen, setLangOpen] = useState(false);
  const [correcting, setCorrecting] = useState<{ ordinal: number; text: string } | null>(null);
  const [tFilter, setTFilter] = useState('');

  const q = useQuery(async (repo) => {
    const item = await repo.getItem(id);
    if (!item || item.deleted) return null;
    const transcripts = await repo.listTranscripts(id);
    return {
      item,
      transcripts,
      jobs: await repo.listJobs({ itemId: id, limit: 10 }),
      media: await repo.listMedia(id),
      collections: (await repo.listCollections()).filter((col) => col),
      memberOf: await repo.itemCollectionIds(id),
      related: await repo.relatedItems(item, 4),
    };
  }, ['items', 'jobs', 'collections'], [id]);

  useEffect(() => {
    void (async () => {
      const { getRepo } = await import('../services/db');
      await (await getRepo()).markViewed(id);
    })();
  }, [id]);

  const d = q.data;
  const activeT = d?.transcripts.find((t) => t.id === transcriptId) ?? d?.transcripts[0] ?? null;
  const segs = useQuery(async (repo) => (activeT ? repo.getSegments(activeT.id) : []), ['items'], [activeT?.id, activeT?.updatedAt]);

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
  const repoOp = async (fn: (repo: Awaited<ReturnType<typeof import('../services/db').getRepo>>) => Promise<unknown>) => {
    const { getRepo } = await import('../services/db');
    await fn(await getRepo());
    emit('items');
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
    await repoOp(async (repo) => {
      if (item.status === 'CANCELLED') await repo.setStatus(id, 'METADATA_CHECK');
    });
    await schedulePipeline(id);
  });

  const serverAction = (kind: 'captions' | 'transcribe' | 'enrich' | 'metadata') => run(async () => {
    const what = { captions: 'fetch available captions for this video', transcribe: 'upload the attached media file and transcribe it', enrich: 'send this item and its transcript for AI enrichment', metadata: 'fetch page metadata' }[kind];
    if (!(await confirm('Use your server?', `Qivra will ${what} on ${connection?.serverUrl}. Continue?`, 'Continue'))) return;
    await requestServerProcessing(id, kind);
  });

  const modelAction = () => run(async () => {
    if (!settings?.ai.enabled) {
      Alert.alert('No AI model configured', 'Add a model in Settings → AI models. Local extraction already ran on this item.');
      return;
    }
    await requestModelEnrichment(id);
  });

  const del = () => run(async () => {
    if (!(await confirm('Delete this item?', 'Its transcripts, notes and attached media on this phone will be deleted.', 'Delete', true))) return;
    await deleteItemFiles([id]);
    await repoOp((repo) => repo.deleteItems([id]));
    navigation.goBack();
  });

  const shownSegs = (segs.data ?? []).map((s, i) => ({ ...s, i })).filter((s) => !tFilter || s.text.toLowerCase().includes(tFilter.toLowerCase()));
  const pendingJobs = d.jobs.filter((j) => ['queued', 'running', 'failed_retryable'].includes(j.status));

  return (
    <Screen padded={false}>
      <Header
        title={SOURCE_LABELS[item.sourceType]}
        onBack={() => navigation.goBack()}
        actions={<>
          <IconButton icon={item.archived ? 'arrow-undo-outline' : 'archive-outline'} label={item.archived ? 'Restore from archive' : 'Archive'} onPress={() => void run(() => repoOp((r) => r.setArchived([id], !item.archived)))} />
          <IconButton icon="trash-outline" label="Delete item" color={c.danger} onPress={() => void del()} />
        </>}
      />
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.xxl }}>
        {item.thumbnailUrl ? <Image source={{ uri: item.thumbnailUrl }} accessibilityIgnoresInvertColors style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 12, backgroundColor: c.surface, marginBottom: space.md }} /> : null}
        <T v="display" selectable onPress={() => startEdit('title')}>{item.title || item.url || 'Untitled'}</T>
        {item.url ? (
          <T v="small" color="accent" numberOfLines={2} style={{ marginTop: 4, textDecorationLine: 'underline' }} accessibilityRole="text" onPress={() => void Linking.openURL(item.url!)}>{item.url}</T>
        ) : null}
        <T v="small" color="textMuted" style={{ marginTop: 4 }}>
          Saved {formatLocal(item.capturedAt, tz)}{item.author ? ` · ${item.author}` : ''}{item.language !== 'und' ? ` · ${languageName(item.language)}${item.languageMethod === 'heuristic' ? ' (detected)' : ''}` : ''}
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space.sm }}>
          <StatusChip status={item.status} />
          <SyncChip status={item.syncStatus} />
          {item.origin === 'superbrain' ? <Chip label="Imported from SuperBrain" tone="info" /> : null}
        </View>

        {item.status === 'NEEDS_INPUT' || isFailed(item.status) || item.status === 'CANCELLED' ? (
          <Banner
            tone={isFailed(item.status) ? 'danger' : 'warning'}
            title={STATUS_LABELS[item.status]}
            body={item.errorMessage ?? undefined}
            action={<>
              <Button kind="outline" title="Import transcript" icon="document-text-outline" onPress={() => navigation.navigate('TranscriptImport', { itemId: id })} />
              {item.sourceType === 'youtube' && connection ? <Button kind="outline" title="Captions via server" onPress={() => void serverAction('captions')} /> : null}
              {d.media.length && connection ? <Button kind="outline" title="Transcribe on server" onPress={() => void serverAction('transcribe')} /> : null}
              {isFailed(item.status) || item.status === 'CANCELLED' ? <Button kind="outline" title="Retry" icon="refresh" onPress={() => void retry()} /> : null}
            </>}
          />
        ) : null}
        {isPending(item.status) ? (
          <Banner tone="info" title={STATUS_LABELS[item.status]} body="Processing runs on this phone and continues in the background." action={<Button kind="outline" title="Cancel" onPress={() => void run(() => cancelItemProcessing(id))} />} />
        ) : null}
        {item.syncStatus === 'conflicted' ? <Banner tone="warning" title="Edited on another device" action={<Button kind="outline" title="Resolve" onPress={() => navigation.navigate('Conflicts')} />} /> : null}

        <Section title="Your note" action={<IconButton icon="create-outline" label="Edit note" onPress={() => startEdit('note')} />}>
          {item.note ? <T selectable>{item.note}</T> : <T color="textFaint" onPress={() => startEdit('note')}>Add a note — why did you save this?</T>}
        </Section>

        <Section title="Summary" action={<IconButton icon="create-outline" label="Correct summary" onPress={() => startEdit('summary')} />}>
          {item.summary ? (
            <>
              <Provenance origin={item.summaryOrigin} />
              <T selectable style={{ marginTop: space.xs }}>{item.summary}</T>
            </>
          ) : <T color="textFaint">No summary yet. It is extracted once there is text to work from.</T>}
          {e?.keyPoints.length ? (
            <View style={{ marginTop: space.md }}>
              <T v="caption" color="textMuted">Key points</T>
              {e.keyPoints.map((k, i) => <T key={i} v="small" style={{ marginTop: 4 }}>• {k}</T>)}
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
            <Button kind="tonal" title="Enrich with AI" icon="sparkles-outline" onPress={() => void modelAction()} loading={busy} />
            {connection ? <Button kind="outline" title="Enrich on server" icon="server-outline" onPress={() => void serverAction('enrich')} /> : null}
          </View>
        </Section>

        <Section title="Tags" action={<IconButton icon="pricetags-outline" label="Edit tags" onPress={() => startEdit('tags')} />}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {item.tags.length ? item.tags.map((t) => <Chip key={t} label={t} />) : <T color="textFaint">No tags.</T>}
          </View>
          <T v="caption" color="textMuted" style={{ marginTop: space.sm }}>Collections</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 }}>
            {d.collections.map((col) => {
              const on = d.memberOf.includes(col.id);
              return <Chip key={col.id} label={col.name} selected={on} onPress={() => void run(() => repoOp((r) => (on ? r.removeFromCollection(col.id, [id]) : r.addToCollection(col.id, [id]))))} />;
            })}
            <Chip label="New collection" icon="add" onPress={() => navigation.navigate('Collections')} />
          </View>
        </Section>

        {e && (e.tools.length || e.repos.length || e.commands.length) ? (
          <Section title="Tools, repositories & commands">
            <T v="caption" color="textMuted">Copied verbatim from the source. Commands are never run by Qivra.</T>
            {e.tools.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space.sm }}>{e.tools.map((t) => <Chip key={t} label={t} tone="accent" />)}</View> : null}
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
          </Section>
        ) : null}

        {e?.actionItems.length ? (
          <Section title="Action items">
            {e.actionItems.map((a, i) => <T key={i} v="small" style={{ marginBottom: 4 }}>☐ {a}</T>)}
          </Section>
        ) : null}
        {e?.followUpQuestions.length ? (
          <Section title="Follow-up questions">
            {e.followUpQuestions.map((a, i) => <T key={i} v="small" style={{ marginBottom: 4 }}>? {a}</T>)}
          </Section>
        ) : null}

        <Section title="Transcript" action={<IconButton icon="add" label="Import transcript or translation" onPress={() => navigation.navigate('TranscriptImport', { itemId: id })} />}>
          {d.transcripts.length ? (
            <>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {d.transcripts.map((t) => (
                  <Chip key={t.id} label={`${languageName(t.language)}${t.kind === 'translation' ? ' · translation' : ' · original'}`} selected={activeT?.id === t.id} onPress={() => setTranscriptId(t.id)} />
                ))}
              </View>
              {activeT ? (
                <>
                  <T v="caption" color="textFaint" style={{ marginTop: 4 }}>
                    {activeT.origin === 'server' ? 'From your server' : 'Imported on this phone'} · {activeT.source.replace(/_/g, ' ')}{activeT.provider ? ` · ${activeT.provider}` : ''} · {activeT.segmentCount} segment(s){activeT.hasTimestamps ? '' : ' · no timestamps in source'}{activeT.corrected ? ' · corrected by you' : ''} · language {activeT.languageMethod === 'user' ? 'set by you' : activeT.languageMethod === 'provider' ? 'from provider' : 'detected'}
                  </T>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginVertical: space.sm }}>
                    <Button kind="outline" title="Language" onPress={() => setLangOpen(true)} />
                    <Button kind="outline" title="Copy all" icon="copy-outline" onPress={() => void Clipboard.setStringAsync(activeT.text)} />
                    <Button kind="text" title="Remove" onPress={() => void run(async () => { if (await confirm('Remove transcript?', 'This deletes this transcript from the phone.', 'Remove', true)) await repoOp((r) => r.deleteTranscript(activeT.id)); })} />
                  </View>
                  <Field label="Find in transcript" value={tFilter} onChangeText={setTFilter} placeholder="Search words" />
                  {shownSegs.slice(0, 400).map((s) => (
                    <View key={s.i} style={{ flexDirection: 'row', paddingVertical: 6 }}>
                      {s.startMs !== null ? <T v="mono" color="textMuted" style={{ width: 64 }}>{formatTimestamp(s.startMs)}</T> : null}
                      <T selectable style={{ flex: 1 }} onLongPress={() => setCorrecting({ ordinal: s.i, text: s.text })}>{s.text}</T>
                    </View>
                  ))}
                  {shownSegs.length > 400 ? <T v="small" color="textMuted">Showing the first 400 segments. Use search to find the rest.</T> : null}
                  <T v="caption" color="textFaint" style={{ marginTop: space.sm }}>Long-press a line to correct it.</T>
                </>
              ) : null}
            </>
          ) : (
            <View>
              <T color="textMuted">No transcript. Qivra never invents one — import captions or a transcript you have, paste text, or ask your server.</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
                <Button kind="outline" title="Import transcript" onPress={() => navigation.navigate('TranscriptImport', { itemId: id })} />
                <Button kind="outline" title="Attach audio/video" onPress={() => void run(() => pickMediaFile(id))} />
              </View>
            </View>
          )}
          {d.media.length ? <T v="small" color="textMuted" style={{ marginTop: space.sm }}>Attached media: {d.media.map((m) => `${m.name} (${(m.size / 1048576).toFixed(1)} MB${m.uploadedAt ? ', sent to server' : ''})`).join(', ')}</T> : null}
        </Section>

        <Section title="Processing">
          {d.jobs.length ? d.jobs.map((j) => (
            <View key={j.id} style={{ paddingVertical: 4 }}>
              <T v="small">{j.kind.replace(/_/g, ' ')} — {j.status.replace(/_/g, ' ')}{j.attempts ? ` (attempt ${j.attempts})` : ''}</T>
              {j.lastError ? <T v="caption" color={j.status === 'failed_permanent' ? 'danger' : 'textMuted'}>{j.lastError}</T> : null}
            </View>
          )) : <T v="small" color="textMuted">No processing jobs.</T>}
          {pendingJobs.length ? null : <Button kind="text" title="Reprocess on this phone" icon="refresh" onPress={() => void retry()} style={{ alignSelf: 'flex-start' }} />}
          {e ? <T v="caption" color="textFaint">Enrichment: {e.origin === 'local' ? 'local extraction' : e.origin === 'model' ? 'AI model' : 'your server'} · {e.provider} · v{e.version} · {formatLocal(e.generatedAt || item.updatedAt, tz)}</T> : null}
        </Section>

        {d.related.length ? (
          <Section title="Related">
            {d.related.map((r) => <ItemCard key={r.id} item={r} timezone={tz} onPress={() => navigation.push('ItemDetail', { id: r.id })} />)}
          </Section>
        ) : null}
        <Divider />
      </View>

      <Sheet visible={!!edit} onClose={() => setEdit(null)} title={edit === 'tags' ? 'Edit tags' : `Edit ${edit}`}>
        <Field label={edit === 'tags' ? 'Comma-separated tags' : edit ?? ''} value={draft} onChangeText={setDraft} multiline={edit !== 'title' && edit !== 'tags'} style={{ minHeight: 0 }} autoFocus />
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
