import { waitFor } from '@testing-library/react-native';
import * as FS from 'expo-file-system/legacy';
import AudioRecord from '@fugood/react-native-audio-pcm-stream';
import { initWhisper } from 'whisper.rn/index';
import { getRepo } from '../../src/services/db';
import { updateSettings } from '../../src/services/settings';
import { getConnection } from '../../src/services/server';
import { MAX_RECORDING_MS, saveVoiceNote, startRecording, transcribeOnDevice, voiceModeAvailable } from '../../src/services/voice';
import { resetTestRepo } from '../helpers/uiSetup';

jest.mock('../../src/services/server', () => ({ getConnection: jest.fn(async () => ({ baseUrl: 'http://192.168.1.2' })) }));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/files/', EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 60_000_000 })),
  writeAsStringAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
}));

beforeEach(() => { resetTestRepo(); jest.clearAllMocks(); });
afterEach(() => { jest.useRealTimers(); });

test('native capture waits for initialization and writes the captured PCM as WAV', async () => {
  jest.useFakeTimers();
  let ready!: () => void;
  jest.mocked(AudioRecord.init).mockImplementationOnce(() => new Promise<void>((resolve) => { ready = resolve; }));
  const pending = startRecording();
  expect(AudioRecord.start).not.toHaveBeenCalled();
  ready();
  const rec = await pending;
  const receive = jest.mocked(AudioRecord.on).mock.calls.at(-1)![1];
  receive(Buffer.alloc(32000).toString('base64'));
  const stopped = rec.stop();
  await jest.advanceTimersByTimeAsync(300);
  const file = await stopped;
  expect(file).toMatchObject({ durationMs: 1000, bytes: 32044 });
  expect(file.uri).toContain('/media/');
  expect(FS.writeAsStringAsync).toHaveBeenCalledWith(file.uri, expect.stringMatching(/^UklGR/), { encoding: 'base64' });
  await expect(rec.stop()).rejects.toThrow('already ended');
});

test('recording limit stops the native microphone exactly once', async () => {
  jest.useFakeTimers();
  const limit = jest.fn();
  const rec = await startRecording(undefined, limit);
  await jest.advanceTimersByTimeAsync(MAX_RECORDING_MS + 1000);
  expect(limit).toHaveBeenCalledTimes(1);
  expect(AudioRecord.stop).toHaveBeenCalledTimes(1);
  await rec.cancel();
  expect(AudioRecord.stop).toHaveBeenCalledTimes(1);
});

test('pairing alone never selects server upload for voice notes', async () => {
  jest.mocked(FS.getInfoAsync).mockResolvedValueOnce({ exists: false } as never);
  expect((await voiceModeAvailable()).preferred).toBeNull();
  const settings = await updateSettings({ voice: { modelId: 'whisper-base', language: 'auto', preferServer: true } });
  expect(settings.voice.preferServer).toBe(true);
  expect((await voiceModeAvailable()).preferred).toBe('server');
  expect(getConnection).toHaveBeenCalled();
});

test('on-device transcript is saved with audio and searchable text even without segments', async () => {
  const id = await saveVoiceNote({ uri: 'file:///data/files/media/n.wav', durationMs: 1000, bytes: 32044 }, 'device', {
    text: 'Remember the meeting', language: 'en', provider: 'whisper.cpp', segments: [],
  });
  const repo = await getRepo();
  const transcript = (await repo.listTranscripts(id))[0];
  expect(transcript.text).toBe('Remember the meeting');
  expect((await repo.listMedia(id))[0].uri).toContain('/media/');
  expect((await repo.getSegments(transcript.id))[0]).toMatchObject({ startMs: null, text: 'Remember the meeting' });
});

test('cancelling local transcription invokes the native stop and returns no text', async () => {
  let finish!: (result: never) => void;
  const stop = jest.fn(async () => { finish({ isAborted: true, result: '', segments: [] } as never); });
  jest.mocked(initWhisper).mockResolvedValueOnce({ transcribe: () => ({ stop, promise: new Promise((resolve) => { finish = resolve; }) }), release: async () => undefined } as never);
  const abort = new AbortController();
  const job = transcribeOnDevice('file:///test.wav', undefined, abort.signal);
  // Wait for model initialization to install the abort listener.
  await waitFor(() => expect(finish).toBeDefined());
  abort.abort();
  await expect(job).rejects.toThrow('cancelled');
  expect(stop).toHaveBeenCalledTimes(1);
});
