import React, { useState } from 'react';
import { View } from 'react-native';
import { LANGUAGES } from '../core/language';
import type { RootProps } from '../navigation/types';
import { importTranscriptText, pickTranscriptFile } from '../services/capture';
import { Banner, Button, Chip, Field, Header, Screen, T } from '../ui/components';
import { useAction } from '../ui/hooks';
import { space } from '../ui/theme';

export default function TranscriptImportScreen({ navigation, route }: RootProps<'TranscriptImport'>) {
  const { itemId } = route.params;
  const [kind, setKind] = useState<'original' | 'translation'>(route.params.kind ?? 'original');
  const [language, setLanguage] = useState('und');
  const [text, setText] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const { busy, run } = useAction();

  const finish = (r: { segments: number; language: string; hasTimestamps: boolean }) =>
    setResult(`Imported ${r.segments} segment(s) · language ${r.language}${r.hasTimestamps ? ' · with timestamps' : ' · no timestamps in source'}. Re-indexing now.`);

  return (
    <Screen>
      <Header title="Add transcript" subtitle="The original is preserved; translations are stored separately." onBack={() => navigation.goBack()} />
      <T v="caption" color="textMuted">Type</T>
      <View style={{ flexDirection: 'row', marginVertical: space.sm }}>
        <Chip label="Original" selected={kind === 'original'} onPress={() => setKind('original')} />
        <Chip label="Translation" selected={kind === 'translation'} onPress={() => setKind('translation')} />
      </View>
      <T v="caption" color="textMuted">Language</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: space.sm }}>
        {LANGUAGES.slice(0, 14).map((l) => <Chip key={l.code} label={l.code === 'und' ? 'Detect' : l.name} selected={language === l.code} onPress={() => setLanguage(l.code)} />)}
      </View>
      {result ? (
        <>
          <Banner tone="accent" title="Transcript saved" body={result} />
          <Button title="Back to item" onPress={() => navigation.goBack()} />
        </>
      ) : (
        <>
          <Button title="Choose .srt / .vtt / .txt file" icon="document-outline" loading={busy} onPress={() => void run(async () => {
            const f = await pickTranscriptFile();
            if (f) finish(await importTranscriptText(itemId, f.text, { fileName: f.name, kind, language: language === 'und' ? undefined : language, source: kind === 'translation' ? 'user_translation' : undefined }));
          }, 'Import failed')} />
          <T v="small" color="textMuted" style={{ marginVertical: space.md, textAlign: 'center' }}>or paste</T>
          <Field label="Transcript text" value={text} onChangeText={setText} multiline placeholder="SRT, WebVTT, '[mm:ss] text' lines, or plain text" />
          <Button kind="outline" title="Import pasted text" disabled={!text.trim()} loading={busy} onPress={() => void run(async () => {
            finish(await importTranscriptText(itemId, text, { kind, language: language === 'und' ? undefined : language, source: kind === 'translation' ? 'user_translation' : 'paste' }));
          }, 'Import failed')} />
        </>
      )}
    </Screen>
  );
}
