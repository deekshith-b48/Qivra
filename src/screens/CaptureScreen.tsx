import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { View } from 'react-native';
import { requestsFromText } from '../core/share';
import { parseTranscript, TranscriptParseError } from '../core/transcripts';
import type { RootProps } from '../navigation/types';
import { captureRequest, importTranscriptText, pickMediaFile, pickTranscriptFile, type CaptureResult } from '../services/capture';
import { getRepo } from '../services/db';
import { Banner, Button, Chip, Field, Header, Screen, T } from '../ui/components';
import { useAction } from '../ui/hooks';
import { space } from '../ui/theme';

type Mode = 'link' | 'note' | 'transcript' | 'media';

export default function CaptureScreen({ navigation, route }: RootProps<'Capture'>) {
  const [mode, setMode] = useState<Mode>(route.params?.mode ?? 'link');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CaptureResult[] | null>(null);
  const { busy, run } = useAction();

  const done = (res: CaptureResult[]) => {
    if (res.length === 1 && res[0].itemId && !res[0].error) navigation.replace('ItemDetail', { id: res[0].itemId });
    else setResults(res);
  };

  const saveLinkOrNote = () => run(async () => {
    setError(null);
    const reqs = requestsFromText(text, title || undefined);
    if (!reqs.length) return setError(mode === 'link' ? 'Paste a link or some text.' : 'Write something first.');
    if (mode === 'link' && !reqs.some((r) => r.kind === 'url')) return setError('No valid http(s) link found. Use “Note” to save plain text.');
    const res: CaptureResult[] = [];
    for (const r of reqs) {
      const withNote = r.kind === 'url' && note ? { ...r, note: [r.note, note].filter(Boolean).join('\n\n') } : r;
      res.push(await captureRequest(withNote));
    }
    done(res);
  }, 'Could not save');

  const saveTranscript = () => run(async () => {
    setError(null);
    try {
      parseTranscript(text);
    } catch (e) {
      return setError(e instanceof TranscriptParseError ? e.message : String(e));
    }
    const repo = await getRepo();
    const { item } = await repo.createItem({ sourceType: 'text', title: title || 'Pasted transcript', note });
    await importTranscriptText(item.id, text, { source: 'paste' });
    done([{ itemId: item.id, title: item.title, kind: 'text', duplicate: false, status: 'CAPTURED' }]);
  }, 'Could not import transcript');

  const fromFile = () => run(async () => {
    const f = await pickTranscriptFile();
    if (!f) return;
    const repo = await getRepo();
    const { item } = await repo.createItem({ sourceType: 'file', title: title || f.name.replace(/\.(srt|vtt|txt)$/i, ''), note });
    await importTranscriptText(item.id, f.text, { fileName: f.name });
    done([{ itemId: item.id, title: item.title, kind: 'transcript_file', duplicate: false, status: 'CAPTURED' }]);
  }, 'Could not import file');

  const media = () => run(async () => {
    const r = await pickMediaFile();
    if (r) done([r]);
  }, 'Could not import media');

  return (
    <Screen>
      <Header title="Save to Qivra" onBack={() => navigation.goBack()} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: space.md }}>
        {([['link', 'Link'], ['note', 'Note'], ['transcript', 'Transcript'], ['media', 'Audio/video']] as [Mode, string][]).map(([m, l]) => (
          <Chip key={m} label={l} selected={mode === m} onPress={() => { setMode(m); setError(null); }} />
        ))}
      </View>
      {results ? (
        <>
          {results.map((r, i) => (
            <Banner key={i} tone={r.error ? 'danger' : r.duplicate ? 'warning' : 'accent'} title={r.title || 'Item'} body={r.error ?? (r.duplicate ? 'Already in your library — opened the existing item.' : 'Saved. Processing has started.')}
              action={r.itemId ? <Button kind="outline" title="Open" onPress={() => navigation.navigate('ItemDetail', { id: r.itemId! })} /> : undefined} />
          ))}
          <Button title="Done" onPress={() => navigation.goBack()} />
        </>
      ) : mode === 'media' ? (
        <>
          <T color="textMuted">Import an audio or video file you are allowed to process. It is copied into Qivra's private storage (max 200 MB).</T>
          <Banner tone="info" title="Transcription" body="Qivra does not transcribe on the phone. Import a transcript for the file, or send it to your paired server (Whisper) from the item page." />
          <Field label="Title (optional)" value={title} onChangeText={setTitle} />
          <Button title="Choose file" icon="folder-open-outline" onPress={() => void media()} loading={busy} />
        </>
      ) : (
        <>
          {mode === 'link' ? (
            <Field label="Link" value={text} onChangeText={setText} placeholder="https://…  (YouTube, Instagram, GitHub, articles, podcasts)" autoCapitalize="none" keyboardType="url" autoFocus />
          ) : mode === 'note' ? (
            <Field label="Note" value={text} onChangeText={setText} multiline placeholder="Write or paste anything" style={{ minHeight: 0 }} autoFocus />
          ) : (
            <Field label="Transcript (SRT, WebVTT or plain text)" value={text} onChangeText={setText} multiline placeholder={'[00:01] Welcome…\nor paste an .srt/.vtt'} style={{ minHeight: 0 }} />
          )}
          {mode === 'link' ? <Button kind="text" title="Paste from clipboard" icon="clipboard-outline" onPress={() => void Clipboard.getStringAsync().then(setText)} style={{ alignSelf: 'flex-start' }} /> : null}
          <Field label="Title (optional)" value={title} onChangeText={setTitle} />
          {mode !== 'note' ? <Field label="Your note (optional)" value={note} onChangeText={setNote} multiline /> : null}
          {error ? <Banner tone="danger" title={error} /> : null}
          <Button title="Save" icon="checkmark" onPress={() => void (mode === 'transcript' ? saveTranscript() : saveLinkOrNote())} loading={busy} />
          {mode === 'transcript' ? <Button kind="outline" title="Import .srt / .vtt / .txt file" icon="document-outline" onPress={() => void fromFile()} style={{ marginTop: space.sm }} /> : null}
          <T v="small" color="textFaint" style={{ marginTop: space.lg }}>
            Saving a YouTube or Instagram link stores the link and public metadata only. Qivra doesn't download videos or bypass platform restrictions — add captions or a transcript to make the content searchable.
          </T>
        </>
      )}
    </Screen>
  );
}
