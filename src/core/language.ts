/**
 * Offline language identification heuristic (script + stop-word scoring).
 * It is deliberately labelled `heuristic` in the UI; users can correct it.
 * A provider-reported language always takes precedence.
 */

export interface LanguageGuess {
  code: string; // BCP-47 primary tag, or 'und'
  confidence: number; // 0..1
  method: 'heuristic' | 'provider' | 'user';
}

export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'und', name: 'Unknown' },
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'Hindi' },
  { code: 'kn', name: 'Kannada' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'mr', name: 'Marathi' },
  { code: 'bn', name: 'Bengali' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
];

export function languageName(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

const SCRIPTS: [RegExp, string][] = [
  [/[ಀ-೿]/g, 'kn'],
  [/[஀-௿]/g, 'ta'],
  [/[ఀ-౿]/g, 'te'],
  [/[ഀ-ൿ]/g, 'ml'],
  [/[ঀ-৿]/g, 'bn'],
  [/[؀-ۿ]/g, 'ar'],
  [/[぀-ヿ]/g, 'ja'],
  [/[가-힯]/g, 'ko'],
  [/[一-鿿]/g, 'zh'],
];

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'to', 'of', 'that', 'you', 'it', 'this', 'with', 'for', 'are', 'what', 'have'],
  es: ['el', 'la', 'que', 'de', 'y', 'los', 'es', 'en', 'por', 'una', 'para', 'con', 'pero', 'hoy'],
  fr: ['le', 'la', 'et', 'les', 'des', 'est', 'une', 'pour', 'que', 'dans', 'pas', 'vous', 'nous', 'avec'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'ich', 'mit', 'sie', 'den', 'ein', 'auf', 'für', 'wir'],
  pt: ['o', 'a', 'que', 'de', 'e', 'não', 'um', 'uma', 'para', 'com', 'você', 'os', 'mais', 'está'],
  it: ['il', 'di', 'che', 'e', 'la', 'non', 'per', 'una', 'sono', 'con', 'questo', 'gli', 'del', 'anche'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'ik', 'je', 'met', 'voor', 'zijn', 'maar'],
  id: ['yang', 'dan', 'di', 'ini', 'itu', 'dengan', 'untuk', 'tidak', 'ada', 'saya', 'akan', 'dari'],
  tr: ['bir', 've', 'bu', 'için', 'çok', 'ama', 'ne', 'olarak', 'daha', 'gibi', 'değil', 'ile'],
  vi: ['và', 'của', 'là', 'có', 'không', 'những', 'được', 'trong', 'cho', 'này', 'một', 'với'],
};

export function detectLanguage(text: string): LanguageGuess {
  const sample = text.slice(0, 5000);
  const letters = sample.replace(/[\s\d\p{P}\p{S}]/gu, '').length;
  if (letters < 12) return { code: 'und', confidence: 0, method: 'heuristic' };

  for (const [re, code] of SCRIPTS) {
    const n = sample.match(re)?.length ?? 0;
    if (n / letters > 0.3) {
      // Hiragana/Katakana alongside Han → Japanese, otherwise Han → Chinese.
      return { code, confidence: Math.min(1, n / letters + 0.2), method: 'heuristic' };
    }
  }
  const deva = sample.match(/[ऀ-ॿ]/g)?.length ?? 0;
  if (deva / letters > 0.3) {
    const marathi = /(आहे|आणि|नाही|मध्ये)/.test(sample);
    return { code: marathi ? 'mr' : 'hi', confidence: 0.7, method: 'heuristic' };
  }
  const cyr = sample.match(/[Ѐ-ӿ]/g)?.length ?? 0;
  if (cyr / letters > 0.3) {
    return { code: /[іїєґ]/i.test(sample) ? 'uk' : 'ru', confidence: 0.75, method: 'heuristic' };
  }

  const words = sample.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 3) return { code: 'und', confidence: 0, method: 'heuristic' };
  let best = 'und';
  let bestScore = 0;
  let second = 0;
  for (const [code, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const score = words.filter((w) => set.has(w)).length / words.length;
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = code;
    } else if (score > second) second = score;
  }
  if (bestScore < 0.05) return { code: 'und', confidence: 0, method: 'heuristic' };
  const confidence = Math.min(0.95, 0.4 + (bestScore - second) * 4);
  return { code: best, confidence: Number(confidence.toFixed(2)), method: 'heuristic' };
}

export function isValidLanguageCode(code: string): boolean {
  return code === 'und' || /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(code);
}
