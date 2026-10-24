/**
 * Voice capture sheet (OpenWhispr-style): tap to talk, tap to stop, text appears.
 * purpose 'note' saves a voice note; 'dictate' returns the text to the caller
 * (AI Agent question, search box, note field).
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, View } from 'react-native';
import { formatTimestamp } from '../core/transcripts';
import {
  CLOUD_MAX_RECORDING_MS, deleteRecording, ensureMicPermission, ModelMissingError, saveVoiceNote, startRecording, transcribeInCloud, transcribeOnDevice, voiceModeAvailable,
  type Recording, type VoiceMode,
} from '../services/voice';
import { Banner, Button, Sheet, T } from './components';
import { radius, space, useTheme } from './theme';

type Stage =
  | { k: 'setup' }
  | { k: 'starting' }
  | { k: 'idle'; mode: VoiceMode }
  | { k: 'recording'; mode: VoiceMode; ms: number; levels: number[] }
  | { k: 'transcribing'; mode: VoiceMode; progress: number }
  | { k: 'error'; message: string; action?: 'settings' | 'permission' };

export function VoiceSheet({
  visible, onClose, purpose, onText, onSaved, onOpenSettings,
}: {
  visible: boolean;
  onClose: () => void;
  purpose: 'note' | 'dictate';
  onText?: (text: string) => void;
  onSaved?: (itemId: string) => void;
  onOpenSettings?: () => void;
}) {
  const { c } = useTheme();
  const [stage, setStage] = useState<Stage>({ k: 'setup' });
  const [hint, setHint] = useState('');
  const rec = useRef<Recording | null>(null);
  const session = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);

  const cancelWork = () => {
    session.current++;
    abort.current?.abort();
    abort.current = null;
    void rec.current?.cancel().catch(() => undefined);
    rec.current = null;
  };

  useEffect(() => {
    if (!visible) return;
    const key = ++session.current;
    setStage({ k: 'setup' });
    void (async () => {
      try {
        const a = await voiceModeAvailable();
        if (key !== session.current) return;
        const mode = purpose === 'dictate' ? (a.device ? 'device' : a.cloud ? 'cloud' : null) : a.preferred;
        if (!mode) {
          setStage({ k: 'error', action: 'settings', message: purpose === 'dictate'
            ? `Download ${a.model.label} (${a.model.sizeMb} MB) in Voice & dictation, or add your Groq key in AI models, to dictate.`
            : `Download ${a.model.label} (${a.model.sizeMb} MB) for private transcription on this phone, or add your Groq key in Settings → AI models.` });
          return;
        }
        setHint(mode === 'device' ? `${a.model.label} on this phone. Audio stays here during transcription. Up to 5 minutes.`
          : 'Sent to Groq Whisper with your key for transcription. Up to 12 minutes.');
        setStage({ k: 'idle', mode });
      } catch (e) {
        if (key === session.current) setStage({ k: 'error', message: (e as Error).message });
      }
    })();
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        cancelWork();
        onClose();
      }
    });
    return () => { sub.remove(); cancelWork(); };
  }, [visible, purpose, attempt]);

  const start = async (mode: VoiceMode) => {
    const key = session.current;
    setStage({ k: 'starting' });
    try {
      const p = await ensureMicPermission();
      if (key !== session.current) return;
      if (p !== 'granted') {
        setStage({ k: 'error', action: p === 'blocked' ? 'permission' : undefined, message: p === 'blocked' ? 'Microphone access is turned off for Qivra. Enable it in Android settings.' : 'Qivra needs the microphone to record.' });
        return;
      }
      const levels: number[] = [];
      const recording = await startRecording((level, ms) => {
        if (key !== session.current) return;
        levels.push(level);
        if (levels.length > 40) levels.shift();
        setStage((s) => (s.k === 'recording' ? { ...s, ms, levels: [...levels] } : s));
      }, () => { if (key === session.current) void stop(mode); }, mode === 'cloud' ? CLOUD_MAX_RECORDING_MS : undefined);
      if (key !== session.current) { await recording.cancel(); return; }
      rec.current = recording;
      setStage({ k: 'recording', mode, ms: 0, levels: [] });
    } catch (e) {
      if (key === session.current) setStage({ k: 'error', message: (e as Error).message });
    }
  };

  const stop = async (mode: VoiceMode) => {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    const key = session.current;
    const controller = new AbortController();
    abort.current = controller;
    let temporary: string | null = null;
    setStage({ k: 'transcribing', mode, progress: 0 });
    try {
      const file = await r.stop();
      temporary = file.uri;
      if (key !== session.current) return;
      if (file.durationMs < 400) throw new Error('That was too short. Tap the mic and speak, then tap stop.');
      const t = mode === 'cloud' ? await transcribeInCloud(file.uri) : await transcribeOnDevice(file.uri, (progress) => {
        if (key === session.current) setStage({ k: 'transcribing', mode, progress });
      }, controller.signal);
      if (key !== session.current) return;
      if (!t.text) throw new Error('No speech was recognised. Try again closer to the microphone.');
      if (purpose === 'dictate') {
        onText?.(t.text);
        onClose();
        return;
      }
      const id = await saveVoiceNote(file, mode, t);
      temporary = null;
      if (key !== session.current) return;
      onSaved?.(id);
      onClose();
    } catch (e) {
      if (key !== session.current) return;
      if (e instanceof ModelMissingError) setStage({ k: 'error', action: 'settings', message: e.message });
      else setStage({ k: 'error', message: (e as Error).message });
    } finally {
      if (temporary) await deleteRecording(temporary).catch(() => undefined);
      if (abort.current === controller) abort.current = null;
    }
  };

  const close = () => { cancelWork(); onClose(); };

  return (
    <Sheet visible={visible} onClose={close} title={purpose === 'note' ? 'Voice note' : 'Dictate'}>
      {stage.k === 'error' ? (
        <Banner tone="warning" title="Can't record yet" body={stage.message} action={<>
          {stage.action === 'settings' && onOpenSettings ? <Button kind="outline" title="Voice & dictation" icon="mic-outline" onPress={() => { close(); onOpenSettings(); }} /> : null}
          {stage.action === 'permission' ? <Button kind="outline" title="Open settings" onPress={() => void Linking.openSettings()} /> : null}
          <Button kind="text" title="Try again" onPress={() => setAttempt((n) => n + 1)} />
        </>} />
      ) : null}

      {stage.k === 'idle' || stage.k === 'recording' ? (
        <View style={{ alignItems: 'center', paddingVertical: space.lg }}>
          <T v="small" color="textMuted" style={{ textAlign: 'center', marginBottom: space.lg }}>{hint}</T>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 48, gap: 3, marginBottom: space.lg }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {(stage.k === 'recording' ? stage.levels : []).concat(Array(Math.max(0, 40 - (stage.k === 'recording' ? stage.levels.length : 0))).fill(0)).map((l, i) => (
              <View key={i} style={{ width: 4, borderRadius: 2, height: 4 + Math.round(l * 44), backgroundColor: stage.k === 'recording' ? c.accent : c.border }} />
            ))}
          </View>
          <Pressable
            onPress={() => (stage.k === 'idle' ? void start(stage.mode) : void stop(stage.mode))}
            accessibilityRole="button"
            accessibilityLabel={stage.k === 'idle' ? 'Start recording' : 'Stop recording'}
            style={({ pressed }) => ({ width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: stage.k === 'recording' ? c.danger : c.primary, opacity: pressed ? 0.85 : 1 })}
          >
            <Ionicons name={stage.k === 'recording' ? 'stop' : 'mic'} size={38} color={stage.k === 'recording' ? c.bg : c.onPrimary} />
          </Pressable>
          <T v="title" style={{ marginTop: space.md }}>{stage.k === 'recording' ? formatTimestamp(stage.ms) : 'Tap to speak'}</T>
          {stage.k === 'recording' ? <Button kind="text" title="Cancel" onPress={() => { const r = rec.current; rec.current = null; setStage({ k: 'starting' }); void r?.cancel().then(() => setStage({ k: 'idle', mode: stage.mode })).catch((e: Error) => setStage({ k: 'error', message: e.message })); }} /> : null}
        </View>
      ) : null}

      {stage.k === 'transcribing' ? (
        <View style={{ paddingVertical: space.xl, alignItems: 'center' }}>
          <Ionicons name="sparkles-outline" size={28} color={c.accent} />
          <T accessibilityLiveRegion="polite" v="subtitle" style={{ marginTop: space.sm }}>{stage.mode === 'device' ? 'Transcribing on your phone…' : 'Transcribing with Groq…'}</T>
          <View style={{ width: '100%', height: 6, backgroundColor: c.surfaceAlt, borderRadius: radius.pill, marginTop: space.md, overflow: 'hidden' }}>
            <View style={{ width: `${Math.round((stage.progress || 0.05) * 100)}%`, height: 6, backgroundColor: c.accent }} />
          </View>
        </View>
      ) : null}
      {stage.k === 'setup' || stage.k === 'starting' ? <T color="textMuted">Preparing…</T> : null}
    </Sheet>
  );
}
