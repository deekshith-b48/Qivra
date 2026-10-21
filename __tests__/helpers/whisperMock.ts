/** Test stand-in for whisper.rn (native whisper.cpp is not available under Jest). */
const result = { result: 'hello', language: 'en', segments: [{ text: 'hello', t0: 0, t1: 100 }], isAborted: false };
const ctx = { transcribe: () => ({ stop: async () => undefined, promise: Promise.resolve(result) }), release: async () => undefined };
export const initWhisper = jest.fn(async () => ctx);
export const initParakeet = jest.fn(async () => ctx);
export type WhisperContext = typeof ctx;
export type ParakeetContext = typeof ctx;
