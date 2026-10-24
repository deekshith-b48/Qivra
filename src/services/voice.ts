/**
 * Voice capture and private transcription (OpenWhispr-style) for Qivra.
 *
 * - Microphone permission is requested only when the user taps the mic.
 * - Audio is recorded as 16 kHz mono PCM and saved as a WAV file in app-private storage.
 * - On-device mode: whisper.cpp (Whisper or NVIDIA Parakeet) via whisper.rn — audio never leaves the phone.
 * - Server mode: the WAV is uploaded to the user's own paired server, which uses
 *   transcribe-anything (MLX on Apple Silicon) or faster-whisper.
 */

import { cloudWhisperReady, transcribeMedia } from './cloudWhisper';
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
const VOICE_DIR = () => `${FS.documentDirectory}media/`;
export const MAX_RECORDING_MS = 5 * 60_000;
/** 16 kHz mono WAV is about 1.9 MB a minute; Groq accepts 25 MB. */
export const CLOUD_MAX_RECORDING_MS = 12 * 60_000;

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
    message: 'Qivra records only after you tap the mic, until you stop or close the recorder. With on-device transcription, audio never leaves your phone.',
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

let recordingActive = false;

export async function startRecording(onLevel?: (level: number, elapsedMs: number) => void, onLimit?: () => void, maxMs = MAX_RECORDING_MS): Promise<Recording> {
  if (recordingActive) throw new Error('Another recording is already in progress.');
  recordingActive = true;
  const chunks: string[] = [];
  try {
    // Android init is a native Promise; starting before it resolves can silently capture nothing.
    await AudioRecord.init({ sampleRate: 16000, channels: 1, bitsPerSample: 16, audioSource: 6, bufferSize: 4096, wavFile: 'unused.wav' });
  } catch (e) {
    recordingActive = false;
    throw e;
  }
  const started = Date.now();
  let finishing: Promise<void> | null = null;
  let consumed = false;
  const sub = AudioRecord.on('data', (data) => {
    if (finishing) return;
    chunks.push(data);
    onLevel?.(chunkLevel(data), Date.now() - started);
  });
  const finish = () => {
    if (!finishing) finishing = (async () => {
      clearTimeout(timer);
      sub.remove();
      try {
        AudioRecord.stop();
        // This recorder's stop has no native completion Promise. Allow its final
        // blocking read (4096 bytes at 16 kHz) to release before another init.
        await new Promise((resolve) => setTimeout(resolve, 300));
      } finally {
        recordingActive = false;
      }
    })();
    return finishing;
  };
  const timer = setTimeout(() => { void finish(); onLimit?.(); }, maxMs);
  try {
    AudioRecord.start();
  } catch (e) {
    await finish();
    throw e;
  }
  return {
    async stop() {
      if (consumed) throw new Error('This recording has already ended.');
      consumed = true;
      await finish();
      if (!chunks.length) throw new Error('No audio was captured. Check the microphone and try again.');
      const wav = pcmChunksToWavBase64(chunks);
      chunks.length = 0;
      await ensureDir(VOICE_DIR());
      const uri = `${VOICE_DIR()}${newId('vn')}.wav`;
      await FS.writeAsStringAsync(uri, wav.base64, { encoding: FS.EncodingType.Base64 });
      return { uri, durationMs: wav.durationMs, bytes: wav.bytes };
    },
    async cancel() {
      consumed = true;
      await finish();
      chunks.length = 0;
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
  if (transcribing) throw new Error('Wait for transcription to finish before deleting a model.');
  if (m.id === loadedId) await releaseContext();
  await FS.deleteAsync(`${MODEL_DIR()}${m.file}`, { idempotent: true });
}

let ctx: WhisperContext | ParakeetContext | null = null;
let loadedId: string | null = null;
let transcribing = false;

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
export async function transcribeOnDevice(wavUri: string, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<VoiceTranscript> {
  if (transcribing) throw new Error('Another transcription is still finishing. Try again in a moment.');
  transcribing = true;
  let detach = () => {};
  try {
    if (signal?.aborted) throw new Error('Transcription was cancelled.');
    const s = await getSettings();
    const m = voiceModel(s.voice.modelId);
    const c = await contextFor(m);
    if (signal?.aborted) throw new Error('Transcription was cancelled.');
    const lang = s.voice.language === 'auto' ? undefined : s.voice.language;
    const job = m.engine === 'parakeet'
      ? (c as ParakeetContext).transcribe(wavUri.replace('file://', ''), {})
      : (c as WhisperContext).transcribe(wavUri.replace('file://', ''), { language: lang ?? 'auto', maxLen: 0, onProgress: (p: number) => onProgress?.(p / 100) });
    const abort = () => { void job.stop().catch(() => undefined); };
    signal?.addEventListener('abort', abort);
    detach = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) abort();
    const r = await job.promise;
    if (signal?.aborted || r.isAborted) throw new Error('Transcription was cancelled.');
    const segments = whisperSegmentsToMs(r.segments ?? []);
    const text = r.segments?.length ? segments.map((x) => x.text).join(' ').trim() : (r.result ?? '').trim();
    const language = r.language && r.language !== 'auto' ? r.language : detectLanguage(text).code;
    return { text, segments, language, provider: `${m.engine === 'parakeet' ? 'parakeet' : 'whisper.cpp'} ${m.file} (on device)` };
  } finally { detach(); transcribing = false; }
}

// ── voice notes ────────────────────────────────────────────────────────────
export type VoiceMode = 'device' | 'server' | 'cloud';

export async function voiceModeAvailable(): Promise<{ device: boolean; server: boolean; cloud: boolean; preferred: VoiceMode | null; model: VoiceModel }> {
  const s = await getSettings();
  const m = voiceModel(s.voice.modelId);
  const device = !!(await modelPath(m));
  const server = !!(await getConnection());
  const cloud = await cloudWhisperReady();
  const preferred: VoiceMode | null = s.voice.preferServer && server ? 'server'
    : s.voice.preferCloud && cloud ? 'cloud'
      : device ? 'device' : cloud ? 'cloud' : null;
  return { device, server, cloud, preferred, model: m };
}

/** Transcribe a recording with Groq Whisper (the user's key); an empty text means no speech. */
export async function transcribeInCloud(wavUri: string): Promise<VoiceTranscript> {
  const r = await transcribeMedia(wavUri, 'audio/wav', 'voice.wav');
  const text = r.segments.map((x) => x.text).join(' ').trim();
  return { text, segments: r.segments, language: r.language === 'und' ? 'und' : r.language, provider: 'groq-whisper-large-v3-turbo' };
}

/**
 * Save a recording as a voice note. On-device: transcript is stored immediately.
 * Server: the WAV is uploaded (explicitly chosen by the user) and transcribed there.
 */
export async function saveVoiceNote(rec: { uri: string; durationMs: number; bytes: number }, mode: VoiceMode, transcript?: VoiceTranscript): Promise<string> {
  const repo = await getRepo();
  const title = transcript?.text ? voiceTitle(transcript.text) : `Voice note (${Math.round(rec.durationMs / 1000)}s)`;
  const { item } = await repo.createItem({ sourceType: 'note', title, origin: 'local' });
  try {
    await repo.addMedia(item.id, { uri: rec.uri, name: rec.uri.split('/').pop() ?? 'voice.wav', mime: 'audio/wav', size: rec.bytes });
    if (transcript?.text.trim()) {
      await repo.upsertTranscript({
        itemId: item.id, language: transcript.language, languageMethod: 'provider', kind: 'original', source: mode === 'cloud' ? 'voice_cloud' : 'voice_on_device',
        provider: transcript.provider, format: 'wav', segments: transcript.segments.length ? transcript.segments : [{ startMs: null, endMs: null, text: transcript.text }],
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
  } catch (e) {
    await repo.deleteItems([item.id]);
    throw e;
  }
}

export async function deleteRecording(uri: string): Promise<void> {
  await FS.deleteAsync(uri, { idempotent: true });
}
