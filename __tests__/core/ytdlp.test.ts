import { classifyYtdlpError, parseYtdlpInfo } from '../../src/core/ytdlp';

test("yt-dlp's info line gives the downloaded file, caption and duration", () => {
  const out = `[debug] noise\n${JSON.stringify({ id: 'C8abc', title: 'Video by ai.explained', description: 'RAG in 60 seconds', duration: 58.4, ext: 'm4a', filename: '/data/user/0/com.qivra.app/cache/ytdl/C8abc.m4a' })}\n`;
  expect(parseYtdlpInfo(out)).toEqual({ path: '/data/user/0/com.qivra.app/cache/ytdl/C8abc.m4a', mime: 'audio/mp4', title: 'Video by ai.explained', description: 'RAG in 60 seconds', durationMs: 58400 });
  expect(parseYtdlpInfo(JSON.stringify({ requested_downloads: [{ filepath: '/c/x.webm' }] }))?.mime).toBe('audio/webm');
  expect(parseYtdlpInfo('no json here')).toBeNull();
  expect(parseYtdlpInfo('{"title":"no file"}')).toBeNull();
});

test('yt-dlp errors: Instagram refusing is "blocked", a lost connection is "offline"', () => {
  expect(classifyYtdlpError('ERROR: [Instagram] C8abc: Requested content is not available, rate-limit reached or login required. Use --cookies')).toBe('BLOCKED');
  expect(classifyYtdlpError('ERROR: [Instagram] x: Unable to download webpage: HTTP Error 429: Too Many Requests')).toBe('BLOCKED');
  expect(classifyYtdlpError('ERROR: Unable to download webpage: <urlopen error [Errno 7] No address associated with hostname>')).toBe('OFFLINE');
  expect(classifyYtdlpError('ERROR: Unsupported URL')).toBe('FAILED');
});
