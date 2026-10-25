/**
 * Parses an OpenAI-compatible Whisper `verbose_json` transcription (Groq's
 * `/audio/translations` or `/audio/transcriptions`) into Qivra transcript segments. Pure, unit-tested.
 */

export interface WhisperResult {
  /** ISO 639-1 code when known, else 'und'. */
  language: string;
  durationMs: number | null;
  segments: { startMs: number; endMs: number; text: string }[];
  /** Nothing was said: music only, silence, or Whisper's usual filler. */
  noSpeech: boolean;
}

// Whisper reports languages by English name; the common ones are mapped, the rest fall back to 'und'.
const LANGS: Record<string, string> = {
  english: 'en', hindi: 'hi', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', russian: 'ru',
  japanese: 'ja', korean: 'ko', chinese: 'zh', arabic: 'ar', turkish: 'tr', dutch: 'nl', polish: 'pl', indonesian: 'id',
  tamil: 'ta', telugu: 'te', kannada: 'kn', malayalam: 'ml', marathi: 'mr', bengali: 'bn', gujarati: 'gu', punjabi: 'pa',
  urdu: 'ur', vietnamese: 'vi', thai: 'th', ukrainian: 'uk', swedish: 'sv', persian: 'fa',
};

// Text Whisper produces for music or silence rather than speech.
const FILLER = /^[\s♪♫.,!?-]*(\[(music|applause|silence|no speech)[^\]]*\]|\((music|applause)\)|thank you( for watching)?\.?|music)?[\s♪♫.,!?-]*$/i;

export function parseWhisperVerbose(json: unknown): WhisperResult {
  const o = (json ?? {}) as { language?: unknown; duration?: unknown; text?: unknown; segments?: unknown };
  const lang = typeof o.language === 'string' ? o.language.toLowerCase().trim() : '';
  const language = lang.length === 2 ? lang : LANGS[lang] ?? 'und';
  const durationMs = typeof o.duration === 'number' && Number.isFinite(o.duration) ? Math.round(o.duration * 1000) : null;
  const raw = Array.isArray(o.segments) ? o.segments : [];
  const segments = raw.flatMap((s) => {
    const x = s as { start?: unknown; end?: unknown; text?: unknown; no_speech_prob?: unknown };
    const text = typeof x.text === 'string' ? x.text.trim() : '';
    if (!text || (typeof x.no_speech_prob === 'number' && x.no_speech_prob > 0.8) || FILLER.test(text)) return [];
    const start = typeof x.start === 'number' ? x.start : 0;
    const end = typeof x.end === 'number' ? x.end : start;
    return [{ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), text }];
  });
  // No segments (some providers omit them): fall back to the plain text as one untimed block.
  const text = typeof o.text === 'string' ? o.text.trim() : '';
  if (!raw.length && text && !FILLER.test(text)) segments.push({ startMs: 0, endMs: durationMs ?? 0, text });
  return { language, durationMs, segments, noSpeech: segments.length === 0 };
}
