/** Live network checks (opt-in): QIVRA_LIVE=1 npx jest __tests__/core/live */
import { fetchMetadata } from '../../src/core/metadata';
import { analyzeUrl } from '../../src/core/url';
import { fetchYouTubeCaptions } from '../../src/core/youtubeCaptions';

const live = process.env.QIVRA_LIVE === '1' ? describe : describe.skip;

const fetchText = async (url: string, opts: { accept: string; timeoutMs: number }) => {
  const r = await fetch(url, { headers: { Accept: opts.accept }, signal: AbortSignal.timeout(opts.timeoutMs) });
  return { ok: r.ok, status: r.status, text: await r.text(), contentType: r.headers.get('content-type') ?? '' };
};

live('live services', () => {
  test('YouTube captions for a public video', async () => {
    const r = await fetchYouTubeCaptions('jNQXAC9IVRw', fetch as never);
    expect(r.segments.length).toBeGreaterThan(0);
    expect(r.segments[0].startMs).not.toBeNull();
  }, 20000);

  test('YouTube Shorts link resolves and has captions or fails honestly', async () => {
    const info = analyzeUrl('https://youtube.com/shorts/BGQWPY4IigY');
    await fetchYouTubeCaptions(info!.youtubeId!, fetch as never).then(
      (r) => expect(r.segments.length).toBeGreaterThan(0),
      (e) => expect(['NO_TRACKS', 'EMPTY']).toContain(e.code),
    );
  }, 20000);

  test('X post text via oEmbed', async () => {
    const m = await fetchMetadata(analyzeUrl('https://twitter.com/captainamerica/status/719944021058060289')!, fetchText);
    expect(m?.provider).toBe('x-oembed');
    expect(m?.bodyText.length).toBeGreaterThan(10);
  }, 20000);

  test('readable article text from a real page', async () => {
    const m = await fetchMetadata(analyzeUrl('https://en.wikipedia.org/wiki/Knowledge_management')!, fetchText);
    expect(m?.bodyText.length).toBeGreaterThan(1000);
  }, 20000);
});
