/**
 * Voice capture sheet (OpenWhispr-style): tap to talk, tap to stop, text appears.
 * purpose 'note' saves a voice note; 'dictate' returns the text to the caller
 * (AI Agent question, search box, note field).
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { formatTimestamp } from '../core/transcripts';
import {
  deleteRecording, ensureMicPermission, ModelMissingError, saveVoiceNote, startRecording, transcribeOnDevice, voiceModeAvailable,
  type Recording, type VoiceMode,
} from '../services/voice';
import { Banner, Button, Sheet, T } from './components';
import { radius, space, useTheme } from './theme';

type Stage =
  | { k: 'setup' }
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

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void (async () => {
      const a = await voiceModeAvailable();
      if (!alive) return;
      if (!a.preferred) {
        setStage({ k: 'error', action: 'settings', message: `Download the ${a.model.label} speech model (${a.model.sizeMb} MB) to transcribe privately on this phone, or connect your server.` });
        return;
      }
      if (purpose === 'dictate' && a.preferred === 'server' && !a.device) {
        setStage({ k: 'error', action: 'settings', message: 'Dictation needs the on-device speech model so text appears instantly. Download it in Voice & dictation.' });
        return;
      }
      const mode: VoiceMode = purpose === 'dictate' ? 'device' : a.preferred;
      setHint(mode === 'device' ? `${a.model.label} on this phone — audio never leaves your device.` : 'Recording will be sent to your Qivra server for transcription.');
      setStage({ k: 'idle', mode });
    })();
    return () => {
      alive = false;
      void rec.current?.cancel();
      rec.current = null;
    };
  }, [visible, purpose]);

  const start = async (mode: VoiceMode) => {
    const p = await ensureMicPermission();
    if (p !== 'granted') {
      setStage({ k: 'error', action: p === 'blocked' ? 'permission' : undefined, message: p === 'blocked' ? 'Microphone access is turned off for Qivra. Enable it in Android settings.' : 'Qivra needs the microphone to record.' });
      return;
    }
    const levels: number[] = [];
    setStage({ k: 'recording', mode, ms: 0, levels: [] });
    rec.current = startRecording((level, ms) => {
      levels.push(level);
      if (levels.length > 40) levels.shift();
      setStage((s) => (s.k === 'recording' ? { ...s, ms, levels: [...levels] } : s));
    });
  };

  const stop = async (mode: VoiceMode) => {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    try {
      const file = await r.stop();
      if (file.durationMs < 400) {
        await deleteRecording(file.uri);
        setStage({ k: 'error', message: 'That was too short. Tap the mic and speak, then tap stop.' });
        return;
      }
      if (mode === 'server') {
        setStage({ k: 'transcribing', mode, progress: 0 });
        const id = await saveVoiceNote(file, 'server');
        onSaved?.(id);
        onClose();
        return;
      }
      setStage({ k: 'transcribing', mode, progress: 0 });
      const t = await transcribeOnDevice(file.uri, (progress) => setStage({ k: 'transcribing', mode, progress }));
      if (!t.text) {
        setStage({ k: 'error', message: 'No speech was recognised. Try again closer to the microphone.' });
        await deleteRecording(file.uri);
        return;
      }
      if (purpose === 'dictate') {
        await deleteRecording(file.uri);
        onText?.(t.text);
        onClose();
        return;
      }
      const id = await saveVoiceNote(file, 'device', t);
      onSaved?.(id);
      onClose();
    } catch (e) {
      if (e instanceof ModelMissingError) setStage({ k: 'error', action: 'settings', message: e.message });
      else setStage({ k: 'error', message: (e as Error).message });
    }
  };

  const close = () => {
    void rec.current?.cancel();
    rec.current = null;
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={close} title={purpose === 'note' ? 'Voice note' : 'Dictate'}>
      {stage.k === 'error' ? (
        <Banner tone="warning" title="Can't record yet" body={stage.message} action={<>
          {stage.action === 'settings' && onOpenSettings ? <Button kind="outline" title="Voice & dictation" icon="mic-outline" onPress={() => { close(); onOpenSettings(); }} /> : null}
          {stage.action === 'permission' ? <Button kind="outline" title="Open settings" onPress={() => void Linking.openSettings()} /> : null}
          <Button kind="text" title="Try again" onPress={() => setStage({ k: 'setup' })} />
        </>} />
      ) : null}

      {stage.k === 'idle' || stage.k === 'recording' ? (
        <View style={{ alignItems: 'center', paddingVertical: space.lg }}>
          <T v="small" color="textMuted" style={{ textAlign: 'center', marginBottom: space.lg }}>{hint}</T>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 48, gap: 3, marginBottom: space.lg }} accessibilityElementsHidden>
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
            <Ionicons name={stage.k === 'recording' ? 'stop' : 'mic'} size={38} color={stage.k === 'recording' ? '#fff' : c.onPrimary} />
          </Pressable>
          <T v="title" style={{ marginTop: space.md }}>{stage.k === 'recording' ? formatTimestamp(stage.ms) : 'Tap to speak'}</T>
          {stage.k === 'recording' ? <Button kind="text" title="Cancel" onPress={() => { void rec.current?.cancel(); rec.current = null; setStage({ k: 'idle', mode: stage.mode }); }} /> : null}
        </View>
      ) : null}

      {stage.k === 'transcribing' ? (
        <View style={{ paddingVertical: space.xl, alignItems: 'center' }}>
          <Ionicons name="sparkles-outline" size={28} color={c.accent} />
          <T v="subtitle" style={{ marginTop: space.sm }}>{stage.mode === 'device' ? 'Transcribing on your phone…' : 'Uploading to your server…'}</T>
          <View style={{ width: '100%', height: 6, backgroundColor: c.surfaceAlt, borderRadius: radius.pill, marginTop: space.md, overflow: 'hidden' }}>
            <View style={{ width: `${Math.round((stage.progress || 0.05) * 100)}%`, height: 6, backgroundColor: c.accent }} />
          </View>
        </View>
      ) : null}
      {stage.k === 'setup' ? <T color="textMuted">Preparing…</T> : null}
    </Sheet>
  );
}
