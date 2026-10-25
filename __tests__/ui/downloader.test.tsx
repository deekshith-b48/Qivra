import { NativeModules } from 'react-native';
import { getRepo } from '../../src/services/db';
import { downloadReelAudio } from '../../src/services/downloader';
import { resetTestRepo } from '../helpers/uiSetup';

jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: jest.fn(async () => ({ exists: true })) }));

const INFO = JSON.stringify({ id: 'C8', filename: '/data/cache/ytdl/C8.m4a', description: 'cap' });
const native = { downloadAudio: jest.fn(), update: jest.fn(async () => 'DONE 2026.10.21'), version: jest.fn() };

beforeEach(() => {
  resetTestRepo();
  NativeModules.QivraDownloader = native;
  native.downloadAudio.mockReset();
  native.update.mockClear();
});

test('a stale yt-dlp is updated before downloading, then not again for a week', async () => {
  native.downloadAudio.mockResolvedValue(INFO);
  expect(await downloadReelAudio('https://www.instagram.com/reel/C8/')).toMatchObject({ uri: 'file:///data/cache/ytdl/C8.m4a', mime: 'audio/mp4', description: 'cap' });
  await downloadReelAudio('https://www.instagram.com/reel/C8/');
  expect(native.update).toHaveBeenCalledTimes(1);
});

test('a refused download updates yt-dlp at once and tries again', async () => {
  await (await getRepo()).setMeta('ytdlp.updatedAt', String(Date.now() - 2 * 3_600_000)); // updated 2 h ago
  native.downloadAudio.mockRejectedValueOnce(new Error('ERROR: [Instagram] C8: Requested content is not available, rate-limit reached or login required')).mockResolvedValueOnce(INFO);
  expect((await downloadReelAudio('https://www.instagram.com/reel/C8/')).path).toBe('/data/cache/ytdl/C8.m4a');
  expect(native.update).toHaveBeenCalledTimes(1);
  expect(native.downloadAudio).toHaveBeenCalledTimes(2);
  // Refused again right after an update: reported as blocked, no update loop.
  native.downloadAudio.mockRejectedValue(new Error('ERROR: [Instagram] C8: login required'));
  await expect(downloadReelAudio('https://www.instagram.com/reel/C8/')).rejects.toMatchObject({ code: 'BLOCKED' });
  expect(native.update).toHaveBeenCalledTimes(1);
});
