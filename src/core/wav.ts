/**
 * WAV assembly for voice notes: the microphone stream delivers base64 chunks of
 * 16-bit little-endian mono PCM; whisper.cpp reads 16 kHz PCM WAV files.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)];
    const b = LOOKUP[clean.charCodeAt(i + 1)];
    const c = i + 2 < clean.length ? LOOKUP[clean.charCodeAt(i + 2)] : -1;
    const d = i + 3 < clean.length ? LOOKUP[clean.charCodeAt(i + 3)] : -1;
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0 && o < len) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0 && o < len) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    out += `${B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=')}=`;
  }
  return out;
}

export function wavHeader(dataBytes: number, sampleRate = 16000, channels = 1, bitsPerSample = 16): Uint8Array {
  const h = new DataView(new ArrayBuffer(44));
  const str = (o: number, s: string) => [...s].forEach((ch, i) => h.setUint8(o + i, ch.charCodeAt(0)));
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  str(0, 'RIFF');
  h.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true); // PCM
  h.setUint16(22, channels, true);
  h.setUint32(24, sampleRate, true);
  h.setUint32(28, byteRate, true);
  h.setUint16(32, (channels * bitsPerSample) / 8, true);
  h.setUint16(34, bitsPerSample, true);
  str(36, 'data');
  h.setUint32(40, dataBytes, true);
  return new Uint8Array(h.buffer);
}

/** Concatenate base64 PCM chunks into a complete WAV file (as base64, ready to write to disk). */
export function pcmChunksToWavBase64(chunks: string[], sampleRate = 16000): { base64: string; durationMs: number; bytes: number } {
  const parts = chunks.map(base64ToBytes);
  const dataBytes = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(44 + dataBytes);
  all.set(wavHeader(dataBytes, sampleRate), 0);
  let o = 44;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return { base64: bytesToBase64(all), durationMs: Math.round((dataBytes / 2 / sampleRate) * 1000), bytes: all.length };
}

/** Peak level 0..1 of a base64 16-bit PCM chunk (for the recording meter). */
export function chunkLevel(b64: string): number {
  const bytes = base64ToBytes(b64);
  let peak = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const v = Math.abs((bytes[i] | (bytes[i + 1] << 8)) << 16 >> 16);
    if (v > peak) peak = v;
  }
  return Math.min(1, peak / 32768);
}
