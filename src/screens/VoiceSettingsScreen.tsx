import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Alert, View } from 'react-native';
import { LANGUAGES } from '../core/language';
import { VOICE_MODELS, type VoiceModel } from '../core/voiceModels';
import type { RootProps } from '../navigation/types';
import { deleteModel, downloadModel, modelPath } from '../services/voice';
import { updateSettings } from '../services/settings';
import { Banner, Button, Card, Chip, Header, Screen, Section, T, ToggleRow } from '../ui/components';
import { confirm, useQuery } from '../ui/hooks';
import { radius, space, useTheme } from '../ui/theme';
import { useConnection, useSettings } from '../ui/useSettings';

export default function VoiceSettingsScreen({ navigation }: RootProps<'VoiceSettings'>) {
  const { c } = useTheme();
  const s = useSettings();
  const { connection } = useConnection();
  const [progress, setProgress] = useState<Record<string, number>>({});
  const installed = useQuery(async () => {
    const out: Record<string, boolean> = {};
    for (const m of VOICE_MODELS) out[m.id] = !!(await modelPath(m));
    return out;
  }, ['settings'], [progress]);

  const download = async (m: VoiceModel) => {
    if (!(await confirm(`Download ${m.label}?`, `${m.sizeMb} MB from Hugging Face. Use Wi-Fi if you can. After this, transcription runs entirely on your phone.`, 'Download'))) return;
    setProgress((p) => ({ ...p, [m.id]: 0.001 }));
    try {
      await downloadModel(m, (f) => setProgress((p) => ({ ...p, [m.id]: Math.max(0.001, f) })));
      await updateSettings({ voice: { ...(s?.voice ?? { language: 'auto', preferServer: false }), modelId: m.id } });
    } catch (e) {
      Alert.alert('Download failed', (e as Error).message);
    } finally {
      setProgress((p) => {
        const { [m.id]: _drop, ...rest } = p;
        return rest;
      });
    }
  };

  if (!s) return <Screen><Header title="Voice & dictation" onBack={() => navigation.goBack()} /></Screen>;
  return (
    <Screen>
      <Header title="Voice & dictation" subtitle="Speak instead of type — notes, questions and search." onBack={() => navigation.goBack()} />
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Ionicons name="shield-checkmark-outline" size={20} color={c.accent} />
          <T v="subtitle">Private by default</T>
        </View>
        <T v="small" color="textMuted" style={{ marginTop: 4 }}>
          Speech is transcribed on this phone with whisper.cpp (Whisper or NVIDIA Parakeet). Audio never leaves the device unless you choose your own server below. Inspired by OpenWhispr.
        </T>
      </Card>

      <Section title="On-device model">
        {VOICE_MODELS.map((m) => {
          const isInstalled = installed.data?.[m.id];
          const selected = s.voice.modelId === m.id;
          const p = progress[m.id];
          return (
            <Card key={m.id} style={{ marginBottom: space.sm, borderColor: selected ? c.accent : c.border, borderWidth: selected ? 2 : undefined }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <T v="subtitle">{m.label}</T>
                  <T v="caption" color="textMuted">{m.sizeMb} MB · {m.languages}</T>
                  <T v="small" color="textMuted">{m.note}</T>
                </View>
                {selected && isInstalled ? <Chip label="In use" tone="accent" icon="checkmark" /> : null}
              </View>
              {p !== undefined ? (
                <View style={{ marginTop: space.sm }}>
                  <View style={{ height: 6, borderRadius: radius.pill, backgroundColor: c.surfaceAlt, overflow: 'hidden' }}>
                    <View style={{ width: `${Math.round(p * 100)}%`, height: 6, backgroundColor: c.accent }} />
                  </View>
                  <T v="caption" color="textMuted">Downloading… {Math.round(p * 100)}%</T>
                </View>
              ) : (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
                  {isInstalled ? (
                    <>
                      {!selected ? <Button kind="tonal" title="Use this model" onPress={() => void updateSettings({ voice: { ...s.voice, modelId: m.id } })} /> : null}
                      <Button kind="text" title={`Delete (${m.sizeMb} MB)`} onPress={() => void (async () => {
                        if (await confirm(`Delete ${m.label}?`, 'You can download it again later.', 'Delete', true)) {
                          await deleteModel(m);
                          setProgress((x) => ({ ...x }));
                        }
                      })()} />
                    </>
                  ) : <Button kind={selected ? 'filled' : 'outline'} title={`Download ${m.sizeMb} MB`} icon="download-outline" onPress={() => void download(m)} />}
                </View>
              )}
            </Card>
          );
        })}
      </Section>

      <Section title="Spoken language">
        <T v="small" color="textMuted">Auto-detect works for most speech; picking your language is faster and more accurate for short notes. (Parakeet always auto-detects.)</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space.sm }}>
          {LANGUAGES.slice(0, 16).map((l) => (
            <Chip key={l.code} label={l.code === 'und' ? 'Auto-detect' : l.name} selected={(s.voice.language === 'auto' && l.code === 'und') || s.voice.language === l.code}
              onPress={() => void updateSettings({ voice: { ...s.voice, language: l.code === 'und' ? 'auto' : l.code } })} />
          ))}
        </View>
      </Section>

      <Section title="Voice notes on your server">
        {connection ? (
          <ToggleRow title="Transcribe voice notes on my server" subtitle="Uploads the recording to your paired Qivra server (transcribe-anything with MLX on Apple Silicon, or faster-whisper). Dictation always stays on the phone." value={s.voice.preferServer} onChange={(v) => void updateSettings({ voice: { ...s.voice, preferServer: v } })} />
        ) : <Banner tone="info" title="No server connected" body="Connect your server to transcribe long recordings with transcribe-anything on your laptop." action={<Button kind="outline" title="Connect" onPress={() => navigation.navigate('ConnectServer')} />} />}
      </Section>
    </Screen>
  );
}
