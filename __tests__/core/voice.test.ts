import { DEFAULT_VOICE_MODEL, VOICE_MODELS, voiceModel, voiceTitle, whisperSegmentsToMs } from '../../src/core/voiceModels';
import { base64ToBytes, bytesToBase64, chunkLevel, pcmChunksToWavBase64, wavHeader } from '../../src/core/wav';

describe('WAV assembly for voice notes', () => {
  test('base64 round-trips arbitrary bytes', () => {
    for (const n of [0, 1, 2, 3, 4, 255, 1000]) {
      const b = Uint8Array.from({ length: n }, (_x, i) => (i * 37) & 255);
      expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
      expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'));
    }
  });

  test('PCM chunks become a valid 16 kHz mono 16-bit WAV', () => {
    const pcm = new Int16Array(16000); // 1 second
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 10) * 8000);
    const bytes = new Uint8Array(pcm.buffer);
    const chunks = [Buffer.from(bytes.subarray(0, 10000)).toString('base64'), Buffer.from(bytes.subarray(10000)).toString('base64')];
    const wav = pcmChunksToWavBase64(chunks);
    const out = Buffer.from(wav.base64, 'base64');
    expect(out.subarray(0, 4).toString()).toBe('RIFF');
    expect(out.subarray(8, 12).toString()).toBe('WAVE');
    expect(out.readUInt16LE(22)).toBe(1); // mono
    expect(out.readUInt32LE(24)).toBe(16000);
    expect(out.readUInt16LE(34)).toBe(16);
    expect(out.readUInt32LE(40)).toBe(32000);
    expect(wav).toMatchObject({ durationMs: 1000, bytes: 32044 });
    expect(Buffer.compare(out.subarray(44), Buffer.from(bytes))).toBe(0);
    expect(wavHeader(10).length).toBe(44);
  });

  test('level meter', () => {
    const loud = Buffer.from(new Int16Array([0, 16384, -32768]).buffer).toString('base64');
    expect(chunkLevel(loud)).toBe(1);
    expect(chunkLevel(Buffer.from(new Int16Array([0, 0]).buffer).toString('base64'))).toBe(0);
  });
});

describe('on-device speech models', () => {
  test('catalog and defaults', () => {
    expect(voiceModel(undefined).id).toBe(DEFAULT_VOICE_MODEL);
    expect(VOICE_MODELS.map((m) => m.engine)).toEqual(['whisper', 'whisper', 'whisper', 'parakeet']);
    for (const m of VOICE_MODELS) expect(m.url).toMatch(/^https:\/\/huggingface\.co\/.+\.bin$/);
  });

  test('whisper.cpp 10 ms units → ms; non-speech markers dropped', () => {
    expect(whisperSegmentsToMs([{ text: ' Hello there ', t0: 0, t1: 150 }, { text: '[BLANK_AUDIO]', t0: 150, t1: 300 }, { text: '(wind blowing)', t0: 300, t1: 400 }, { text: 'Next idea.', t0: 400, t1: 520 }]))
      .toEqual([{ startMs: 0, endMs: 1500, text: 'Hello there' }, { startMs: 4000, endMs: 5200, text: 'Next idea.' }]);
  });

  test('voice titles', () => {
    expect(voiceTitle('')).toBe('Voice note');
    expect(voiceTitle('Remember to try the new Claude Code hooks feature with the team tomorrow morning please')).toBe('Remember to try the new Claude Code hooks feature with the…');
  });
});
