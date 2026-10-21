/**
 * On-device speech models (OpenWhispr-style local transcription), run through
 * whisper.cpp via whisper.rn. Files download on demand from Hugging Face into
 * app-private storage; nothing is bundled in the APK and audio never leaves the
 * phone in on-device mode.
 */

export type VoiceEngine = 'whisper' | 'parakeet';

export interface VoiceModel {
  id: string;
  engine: VoiceEngine;
  label: string;
  file: string;
  url: string;
  sizeMb: number;
  minBytes: number; // sanity check for a complete download
  languages: string;
  note: string;
}

const WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const VOICE_MODELS: VoiceModel[] = [
  { id: 'whisper-tiny', engine: 'whisper', label: 'Whisper Tiny', file: 'ggml-tiny-q5_1.bin', url: `${WHISPER}/ggml-tiny-q5_1.bin`, sizeMb: 32, minBytes: 30e6, languages: '99 languages', note: 'Fastest, lowest accuracy.' },
  { id: 'whisper-base', engine: 'whisper', label: 'Whisper Base', file: 'ggml-base-q5_1.bin', url: `${WHISPER}/ggml-base-q5_1.bin`, sizeMb: 60, minBytes: 55e6, languages: '99 languages', note: 'Recommended balance of speed and accuracy.' },
  { id: 'whisper-small', engine: 'whisper', label: 'Whisper Small', file: 'ggml-small-q5_1.bin', url: `${WHISPER}/ggml-small-q5_1.bin`, sizeMb: 190, minBytes: 180e6, languages: '99 languages', note: 'More accurate, slower on mid-range phones.' },
  {
    id: 'parakeet-v3', engine: 'parakeet', label: 'NVIDIA Parakeet TDT v3', file: 'ggml-parakeet-tdt-0.6b-v3-q4_0.bin',
    url: 'https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q4_0.bin', sizeMb: 356, minBytes: 330e6,
    languages: 'English + 24 European languages', note: 'Very accurate and fast for supported languages.',
  },
];

export const DEFAULT_VOICE_MODEL = 'whisper-base';

export function voiceModel(id: string | null | undefined): VoiceModel {
  return VOICE_MODELS.find((m) => m.id === id) ?? (VOICE_MODELS.find((m) => m.id === DEFAULT_VOICE_MODEL) as VoiceModel);
}

/** whisper.cpp segment times are in 10 ms units. */
export function whisperSegmentsToMs(segments: { text: string; t0: number; t1: number }[]): { startMs: number; endMs: number; text: string }[] {
  return segments
    .map((s) => ({ startMs: Math.max(0, Math.round(s.t0 * 10)), endMs: Math.max(0, Math.round(s.t1 * 10)), text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]$/i.test(s.text) && !/^\(.*\)$/.test(s.text));
}

/** First words of a dictation, for an item title. */
export function voiceTitle(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'Voice note';
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
}
