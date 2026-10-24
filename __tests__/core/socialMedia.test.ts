import { instagramEmbedUrl, parseInstagramEmbed, pickXVideo, xSyndicationToken, xSyndicationUrl } from '../../src/core/socialMedia';
import { parseWhisperVerbose } from '../../src/core/whisper';
import X_VIDEO from '../fixtures/x-syndication-video.json';

test('X: token and URL match what the embed widget sends; the smallest MP4 on X\'s CDN is picked', () => {
  // Real response, fetched 2026-10-24 with this token (post 1585341984679469056).
  expect(xSyndicationUrl('1585341984679469056')).toBe(`https://cdn.syndication.twimg.com/tweet-result?id=1585341984679469056&lang=en&token=${xSyndicationToken('1585341984679469056')}`);
  expect(pickXVideo(X_VIDEO)).toEqual({ url: expect.stringMatching(/^https:\/\/video\.twimg\.com\/.+480x270.+\.mp4/), durationMs: 9301 });
  expect(pickXVideo({ text: 'no media' })).toBeNull();
  expect(pickXVideo({ mediaDetails: [{ type: 'video', video_info: { variants: [{ content_type: 'video/mp4', bitrate: 1, url: 'https://evil.example/x.mp4' }] } }] })).toBeNull();
  expect(pickXVideo({ mediaDetails: [{ type: 'photo' }] })).toBeNull();
});

test('Instagram: video and caption from the public embed page; other hosts are refused', () => {
  expect(instagramEmbedUrl('C5ZyJm0P8Z8')).toBe('https://www.instagram.com/p/C5ZyJm0P8Z8/embed/captioned/');
  const page = `<script>{"shortcode_media":{"is_video":true,"video_url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/t50\\/reel.mp4?a=1\\u0026b=2"}}</script>
    <div class="Caption"><a class="CaptionUsername" href="#">natgeo</a> Whales sing <br/>at night &amp; travel far<div class="CaptionComments">`;
  expect(parseInstagramEmbed(page)).toEqual({ videoUrl: 'https://scontent.cdninstagram.com/v/t50/reel.mp4?a=1&b=2', caption: 'Whales sing\nat night & travel far' });
  // JSON escaped twice (inside a JS string), as embed pages often ship it.
  expect(parseInstagramEmbed('"{\\"video_url\\":\\"https:\\\\/\\\\/x.fbcdn.net\\\\/v.mp4\\"}"').videoUrl).toBe('https://x.fbcdn.net/v.mp4');
  expect(parseInstagramEmbed('<meta property="og:video" content="https://evil.example/v.mp4">').videoUrl).toBeNull();
  // A blocked/empty embed: nothing found, no crash.
  expect(parseInstagramEmbed('<title>Instagram</title>')).toEqual({ videoUrl: null, caption: null });
});

test('Whisper verbose_json: timed segments, language name to code, music and filler mean no speech', () => {
  const r = parseWhisperVerbose({ language: 'english', duration: 12.5, text: 'Hi there. Chunking matters.', segments: [
    { start: 0, end: 2.4, text: ' Hi there.', no_speech_prob: 0.01 },
    { start: 2.4, end: 6, text: ' Chunking matters.', no_speech_prob: 0.02 },
    { start: 6, end: 12.5, text: ' ♪♪', no_speech_prob: 0.2 },
  ] });
  expect(r).toEqual({ language: 'en', durationMs: 12500, noSpeech: false, segments: [
    { startMs: 0, endMs: 2400, text: 'Hi there.' }, { startMs: 2400, endMs: 6000, text: 'Chunking matters.' },
  ] });
  expect(parseWhisperVerbose({ language: 'hindi', segments: [{ start: 0, end: 3, text: 'नमस्ते' }] }).language).toBe('hi');
  for (const filler of [' [Music]', ' Thank you.', ' ♪', '']) {
    expect(parseWhisperVerbose({ language: 'english', text: filler, segments: [{ start: 0, end: 5, text: filler }] }).noSpeech).toBe(true);
  }
  expect(parseWhisperVerbose({ text: 'Plain text only', duration: 3 }).segments).toEqual([{ startMs: 0, endMs: 3000, text: 'Plain text only' }]);
  expect(parseWhisperVerbose({ segments: [{ start: 0, end: 1, text: 'quiet?', no_speech_prob: 0.95 }] }).noSpeech).toBe(true);
});
