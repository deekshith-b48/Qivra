/**
 * Voice capture and private transcription (OpenWhispr-style) for Qivra.
 *
 * - Microphone permission is requested only when the user taps the mic.
 * - Audio is recorded as 16 kHz mono PCM and saved as a WAV file in app-private storage.
 * - On-device mode: whisper.cpp (Whisper or NVIDIA Parakeet) via whisper.rn — audio never leaves the phone.
 * - Server mode: the WAV is uploaded to the user's own paired server, which uses
 *   transcribe-anything (MLX on Apple Silicon) or faster-whisper.
 */

import * as FS from 'expo-file-system/legacy';
import { PermissionsAndroid, Platform } from 'react-native';
// The package's exports map has no root entry; the './index' subpath resolves for TS, Metro and Jest alike.
import { initParakeet, initWhisper, type ParakeetContext, type WhisperContext } from 'whisper.rn/index';
import type { PcmAudioRecord } from '../types/audioPcmStream';
import { newId } from '../core/ids';
import { detectLanguage } from '../core/language';
import { voiceModel, voiceTitle, whisperSegmentsToMs, type VoiceModel } from '../core/voiceModels';
import { chunkLevel, pcmChunksToWavBase64 } from '../core/wav';
import { getRepo } from './db';
import { emit } from './events';
import { requestServerProcessing, schedulePipeline } from './processing';
import { getConnection } from './server';
import { getSettings } from './settings';

// The package ships an incorrect type declaration, so it is loaded with require() and typed via PcmAudioRecord.
const AudioRecord: PcmAudioRecord = require('@fugood/react-native-audio-pcm-stream').default;

const MODEL_DIR = () => `${FS.documentDirectory}models/`;
const VOICE_DIR = () => `${FS.documentDirectory}voice/`;
export const MAX_RECORDING_MS = 30 * 60_000;

async function ensureDir(dir: string) {
  if (!(await FS.getInfoAsync(dir)).exists) await FS.makeDirectoryAsync(dir, { intermediates: true });
}

// ── permission ─────────────────────────────────────────────────────────────
export async function ensureMicPermission(): Promise<'granted' | 'denied' | 'blocked'> {
  if (Platform.OS !== 'android') return 'granted';
  const perm = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(perm)) return 'granted';
  const r = await PermissionsAndroid.request(perm, {
    title: 'Microphone for voice notes',
    message: 'Qivra records only while you hold the mic. With on-device transcription, audio never leaves your phone.',
    buttonPositive: 'Allow',
    buttonNegative: 'Not now',
  });
  return r === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied';
}

// ── recording ──────────────────────────────────────────────────────────────
export interface Recording {
  stop(): Promise<{ uri: string; durationMs: number; bytes: number }>;
  cancel(): Promise<void>;
}

export function startRecording(onLevel?: (level: number, elapsedMs: number) => void): Recording {
  const chunks: string[] = [];
  const started = Date.now();
  AudioRecord.init({ sampleRate: 16000, channels: 1, bitsPerSample: 16, audioSource: 6, bufferSize: 4096, wavFile: 'unused.wav' });
  const sub = AudioRecord.on('data', (data) => {
    chunks.push(data);
    onLevel?.(chunkLevel(data), Date.now() - started);
    if (Date.now() - started > MAX_RECORDING_MS) void AudioRecord.stop();
  });
  AudioRecord.start();
  const finish = async () => {
    await AudioRecord.stop();
    sub?.remove();
  };
  return {
    async stop() {
      await finish();
      if (!chunks.length) throw new Error('No audio was captured. Check the microphone and try again.');
      const wav = pcmChunksToWavBase64(chunks);
      await ensureDir(VOICE_DIR());
      const uri = `${VOICE_DIR()}${newId('vn')}.wav`;
      await FS.writeAsStringAsync(uri, wav.base64, { encoding: FS.EncodingType.Base64 });
      return { uri, durationMs: wav.durationMs, bytes: wav.bytes };
    },
    async cancel() {
      await finish();
    },
  };
}

// ── models ─────────────────────────────────────────────────────────────────
export async function modelPath(m: VoiceModel): Promise<string | null> {
  const p = `${MODEL_DIR()}${m.file}`;
  const info = await FS.getInfoAsync(p);
  return info.exists && 'size' in info && (info.size ?? 0) >= m.minBytes ? p : null;
}

export async function downloadModel(m: VoiceModel, onProgress?: (fraction: number) => void): Promise<string> {
  await ensureDir(MODEL_DIR());
  const dest = `${MODEL_DIR()}${m.file}`;
  const tmp = `${dest}.part`;
  const dl = FS.createDownloadResumable(m.url, tmp, {}, (p) => {
    if (p.totalBytesExpectedToWrite > 0) onProgress?.(p.totalBytesWritten / p.totalBytesExpectedToWrite);
  });
  const res = await dl.downloadAsync();
  if (!res || res.status !== 200) {
    await FS.deleteAsync(tmp, { idempotent: true });
    throw new Error(`Model download failed${res ? ` (HTTP ${res.status})` : ''}. Check your connection and try again.`);
  }
  const info = await FS.getInfoAsync(tmp);
  if (!info.exists || !('size' in info) || (info.size ?? 0) < m.minBytes) {
    await FS.deleteAsync(tmp, { idempotent: true });
    throw new Error('The downloaded model is incomplete. Try again on a stable connection.');
  }
  // whisper.cpp model files start with the GGML magic ("lmgg" little-endian) or GGUF.
  const head = await FS.readAsStringAsync(tmp, { encoding: FS.EncodingType.Base64, position: 0, length: 4 });
  if (!['bG1nZw==', 'R0dVRg=='].includes(head)) {
    await FS.deleteAsync(tmp, { idempotent: true });
    throw new Error('The downloaded file is not a valid speech model.');
  }
  await FS.moveAsync({ from: tmp, to: dest });
  return dest;
}

export async function deleteModel(m: VoiceModel): Promise<void> {
  if (m.id === loadedId) await releaseContext();
  await FS.deleteAsync(`${MODEL_DIR()}${m.file}`, { idempotent: true });
}

let ctx: WhisperContext | ParakeetContext | null = null;
let loadedId: string | null = null;

async function releaseContext() {
  try {
    await ctx?.release();
  } catch {
    /* ignore */
  }
  ctx = null;
  loadedId = null;
}

async function contextFor(m: VoiceModel): Promise<WhisperContext | ParakeetContext> {
  if (ctx && loadedId === m.id) return ctx;
  const path = await modelPath(m);
  if (!path) throw new ModelMissingError(m);
  await releaseContext();
  ctx = m.engine === 'parakeet' ? await initParakeet({ filePath: path }) : await initWhisper({ filePath: path });
  loadedId = m.id;
  return ctx;
}

export class ModelMissingError extends Error {
  constructor(public model: VoiceModel) {
    super(`${model.label} (${model.sizeMb} MB) is not downloaded yet.`);
  }
}

export interface VoiceTranscript {
  text: string;
  segments: { startMs: number; endMs: number; text: string }[];
  language: string;
  provider: string;
}

/** Transcribe a 16 kHz WAV on the phone. */
export async function transcribeOnDevice(wavUri: string, onProgress?: (p: number) => void): Promise<VoiceTranscript> {
  const s = await getSettings();
  const m = voiceModel(s.voice.modelId);
  const c = await contextFor(m);
  const lang = s.voice.language === 'auto' ? undefined : s.voice.language;
  const job = m.engine === 'parakeet'
    ? (c as ParakeetContext).transcribe(wavUri.replace('file://', ''), {})
    : (c as WhisperContext).transcribe(wavUri.replace('file://', ''), { language: lang ?? 'auto', maxLen: 0, onProgress: (p: number) => onProgress?.(p / 100) });
  const r = await job.promise;
  if (r.isAborted) throw new Error('Transcription was cancelled.');
  const segments = whisperSegmentsToMs(r.segments ?? []);
  const text = segments.map((x) => x.text).join(' ').trim() || (r.result ?? '').trim();
  const language = r.language && r.language !== 'auto' ? r.language : detectLanguage(text).code;
  return { text, segments, language, provider: `${m.engine === 'parakeet' ? 'parakeet' : 'whisper.cpp'} ${m.file} (on device)` };
}

// ── voice notes ────────────────────────────────────────────────────────────
export type VoiceMode = 'device' | 'server';

export async function voiceModeAvailable(): Promise<{ device: boolean; server: boolean; preferred: VoiceMode | null; model: VoiceModel }> {
  const s = await getSettings();
  const m = voiceModel(s.voice.modelId);
  const device = !!(await modelPath(m));
  const server = !!(await getConnection());
  const preferred: VoiceMode | null = s.voice.preferServer && server ? 'server' : device ? 'device' : server ? 'server' : null;
  return { device, server, preferred, model: m };
}

/**
 * Save a recording as a voice note. On-device: transcript is stored immediately.
 * Server: the WAV is uploaded (explicitly chosen by the user) and transcribed there.
 */
export async function saveVoiceNote(rec: { uri: string; durationMs: number; bytes: number }, mode: VoiceMode, transcript?: VoiceTranscript): Promise<string> {
  const repo = await getRepo();
  const title = transcript?.text ? voiceTitle(transcript.text) : `Voice note (${Math.round(rec.durationMs / 1000)}s)`;
  const { item } = await repo.createItem({ sourceType: 'note', title, origin: 'local' });
  await repo.addMedia(item.id, { uri: rec.uri, name: rec.uri.split('/').pop() ?? 'voice.wav', mime: 'audio/wav', size: rec.bytes });
  if (transcript?.segments.length) {
    await repo.upsertTranscript({
      itemId: item.id, language: transcript.language, languageMethod: 'provider', kind: 'original', source: 'voice_on_device',
      provider: transcript.provider, format: 'wav', segments: transcript.segments,
    });
    await schedulePipeline(item.id);
  } else if (mode === 'server') {
    await schedulePipeline(item.id);
    await requestServerProcessing(item.id, 'transcribe');
  } else {
    await schedulePipeline(item.id);
  }
  emit('items');
  return item.id;
}

export async function deleteRecording(uri: string): Promise<void> {
  await FS.deleteAsync(uri, { idempotent: true });
}
