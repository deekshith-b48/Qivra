import { analyzeUrl, extractUrls, platformName } from '../../src/core/url';
import { normalizeShare, requestsFromText, safeFileName, type ShareEnvelope } from '../../src/core/share';
import { checkServerUrl, isPrivateHost } from '../../src/core/net';

describe('URL normalisation and source detection', () => {
  test.each([
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube', 'youtube:dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&t=42', 'youtube', 'youtube:dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'youtube:dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://www.instagram.com/reel/C8abc_12/?igsh=xyz', 'instagram', 'instagram:C8abc_12', 'https://www.instagram.com/reel/C8abc_12/'],
    ['https://instagram.com/someuser/p/DRWKk5JiL0h/', 'instagram', 'instagram:DRWKk5JiL0h', 'https://www.instagram.com/p/DRWKk5JiL0h/'],
    ['https://github.com/anthropics/claude-code/', 'github', 'github:anthropics/claude-code', 'https://github.com/anthropics/claude-code'],
    ['https://github.com/facebook/react/tree/main/packages', 'github', 'github:facebook/react/tree/main/packages', 'https://github.com/facebook/react/tree/main/packages'],
    ['https://open.spotify.com/episode/123?si=1', 'podcast', 'url:open.spotify.com/episode/123', 'https://open.spotify.com/episode/123'],
    ['https://WWW.Example.com/Post/?utm_source=x&id=7#frag', 'web', 'url:example.com/Post?id=7', 'https://www.example.com/Post?id=7'],
  ])('%s', (raw, type, key, url) => {
    const info = analyzeUrl(raw);
    expect(info?.sourceType).toBe(type);
    expect(info?.dedupeKey).toBe(key);
    expect(info?.url).toBe(url);
  });

  test('duplicates collapse to one key regardless of tracking params', () => {
    const a = analyzeUrl('https://youtu.be/dQw4w9WgXcQ');
    const b = analyzeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_campaign=x');
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
  });

  test('rejects non-http schemes and embedded credentials', () => {
    expect(analyzeUrl('javascript:alert(1)')).toBeNull();
    expect(analyzeUrl('file:///etc/passwd')).toBeNull();
    expect(analyzeUrl('https://user:pw@example.com')).toBeNull();
    expect(analyzeUrl('not a url')).toBeNull();
  });

  test('github reserved paths are not repos', () => {
    expect(analyzeUrl('https://github.com/features/actions')?.sourceType).toBe('web');
  });

  test('extractUrls trims punctuation and dedupes', () => {
    expect(extractUrls('see https://a.dev/x, and https://a.dev/x. also (https://b.dev)')).toEqual(['https://a.dev/x', 'https://b.dev']);
  });

  test('platformName', () => {
    expect(platformName('https://youtu.be/dQw4w9WgXcQ')).toBe('YouTube');
    expect(platformName('https://blog.medium.com/x')).toBe('Medium');
  });
});

describe('Android share payload normalisation', () => {
  const env = (over: Partial<ShareEnvelope>): ShareEnvelope => ({ version: 1, id: 's1', action: 'SEND', receivedAt: '2026-10-21T00:00:00Z', ...over });

  test('shared text with one link keeps the caption as a note', () => {
    const r = requestsFromText('Great Claude Code tips https://youtu.be/dQw4w9WgXcQ', 'Video');
    expect(r).toEqual([{ kind: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', sourceType: 'youtube', dedupeKey: 'youtube:dQw4w9WgXcQ', title: 'Video', note: 'Great Claude Code tips' }]);
  });

  test('text without links becomes a text capture', () => {
    expect(requestsFromText('Remember to try uvx')).toEqual([{ kind: 'text', text: 'Remember to try uvx', title: undefined }]);
  });

  test('empty or whitespace text produces nothing', () => {
    expect(normalizeShare(env({ text: '   ' })).requests).toEqual([]);
  });

  test('multiple links in one share are split and deduplicated', () => {
    const r = normalizeShare(env({ action: 'SEND_MULTIPLE', text: 'https://github.com/a/b https://youtu.be/dQw4w9WgXcQ https://github.com/a/b/' }));
    expect(r.requests.map((x) => (x.kind === 'url' ? x.dedupeKey : x.kind))).toEqual(['github:a/b', 'youtube:dQw4w9WgXcQ']);
  });

  test('files are classified, size-limited and unsupported types rejected', () => {
    const r = normalizeShare(env({
      action: 'SEND_MULTIPLE',
      files: [
        { path: '/data/x/a.srt', name: 'talk.srt', mime: 'application/x-subrip', size: 1200 },
        { path: '/data/x/b.vtt', name: 'b.vtt', mime: 'text/vtt', size: 10 },
        { path: '/data/x/c.mp3', name: 'c.mp3', mime: 'audio/mpeg', size: 5_000_000 },
        { path: '/data/x/d.mp4', name: 'd.mp4', mime: 'video/mp4', size: 300 * 1024 * 1024 },
        { path: '/data/x/e.apk', name: 'e.apk', mime: 'application/vnd.android.package-archive', size: 10 },
        { path: '/data/x/f.txt', name: 'f.txt', mime: 'text/plain', size: 0 },
      ],
      errors: [{ name: 'g.mov', reason: 'Could not read' }],
    }));
    expect(r.requests.map((x) => x.kind)).toEqual(['transcript_file', 'transcript_file', 'media_file']);
    expect(r.rejected.map((x) => x.name)).toEqual(['g.mov', 'd.mp4', 'e.apk', 'f.txt']);
  });

  test('file names cannot carry paths or control characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a\u0000b.srt')).toBe('ab.srt');
    expect(safeFileName('')).toBe('file');
  });
});

describe('network policy', () => {
  test.each(['192.168.1.5', '10.0.2.2', '172.20.0.1', '127.0.0.1', 'localhost', '100.101.1.2', 'mac.local', '169.254.3.3', 'fd12::1', '::1'])(
    'private: %s', (h) => expect(isPrivateHost(h)).toBe(true));
  test.each(['8.8.8.8', '172.32.0.1', 'example.com', '100.128.0.1', '2001:db8::1'])('public: %s', (h) => expect(isPrivateHost(h)).toBe(false));

  test('cleartext only to private hosts', () => {
    expect(checkServerUrl('http://192.168.1.20:5001')).toMatchObject({ ok: true, cleartext: true });
    expect(checkServerUrl('http://example.com:5000')).toMatchObject({ ok: false, code: 'CLEARTEXT_PUBLIC_HOST' });
    expect(checkServerUrl('https://example.com')).toMatchObject({ ok: true, cleartext: false });
    expect(checkServerUrl('ftp://192.168.1.2')).toMatchObject({ ok: false, code: 'UNSUPPORTED_SCHEME' });
    expect(checkServerUrl('http://u:p@192.168.1.2')).toMatchObject({ ok: false, code: 'HAS_CREDENTIALS' });
    expect(checkServerUrl('nonsense')).toMatchObject({ ok: false, code: 'INVALID_URL' });
  });
});
