import { chooseTrack, fetchYouTubeCaptions, parseTimedText, type CaptionTrack } from '../../src/core/youtubeCaptions';
import { extractKeywords, splitHighlights } from '../../src/core/highlights';
import { extractReadableText, htmlToText } from '../../src/core/metadata';

describe('YouTube captions', () => {
  const xml = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>
<p t="1200" d="2160">All right, so here we are, in front of the &amp;elephants</p>
<p t="5318" d="3000"><s>the cool thing</s><s t="400"> about these guys</s></p>
<p t="8000" d="1000">the cool thing about these guys</p>
</body></timedtext>`;

  test('timed-text format 3 parsing keeps real timestamps and merges repeats', () => {
    expect(parseTimedText(xml)).toEqual([
      { startMs: 1200, endMs: 3360, text: 'All right, so here we are, in front of the &elephants' },
      { startMs: 5318, endMs: 9000, text: 'the cool thing about these guys' },
    ]);
  });

  test('legacy srv1 format also parses', () => {
    expect(parseTimedText('<transcript><text start="1.2" dur="2.16">Hi &amp;amp; bye</text></transcript>')).toEqual([{ startMs: 1200, endMs: 3360, text: 'Hi & bye' }]);
  });

  test('track choice: English manual > English auto-generated > original auto-captions > anything', () => {
    const t = (languageCode: string, kind: 'manual' | 'asr'): CaptionTrack => ({ baseUrl: 'https://x', languageCode, kind, name: languageCode });
    expect(chooseTrack([t('de', 'manual'), t('en', 'asr'), t('en', 'manual')], ['en'])?.kind).toBe('manual');
    // A creator's Arabic/Hindi uploads listed before the English auto-captions: English wins.
    expect(chooseTrack([t('ar', 'manual'), t('hi', 'manual'), t('te', 'asr'), t('en', 'asr')], ['en'])).toMatchObject({ languageCode: 'en', kind: 'asr' });
    expect(chooseTrack([t('de', 'manual'), t('hi', 'asr')], ['en'])).toMatchObject({ languageCode: 'hi', kind: 'asr' });
    expect(chooseTrack([t('fr', 'manual')], ['en'])?.languageCode).toBe('fr');
    expect(chooseTrack([], ['en'])).toBeNull();
  });

  test('a non-English track is translated by YouTube (tlang=en); if YouTube refuses, the original comes back', async () => {
    const urls: string[] = [];
    let tlangOk = true;
    const fake = async (url: string) => {
      urls.push(url);
      if (url.includes('/player')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=x', languageCode: 'hi', kind: 'asr' }] } } }) };
      }
      if (url.includes('tlang=')) return { ok: tlangOk, status: tlangOk ? 200 : 429, text: async () => xml };
      return { ok: true, status: 200, text: async () => xml };
    };
    expect(await fetchYouTubeCaptions('x', fake)).toMatchObject({ language: 'en', translatedFrom: 'hi' });
    expect(urls[1]).toMatch(/&fmt=srv3&tlang=en$/);
    tlangOk = false;
    const r = await fetchYouTubeCaptions('x', fake);
    expect(r.language).toBe('hi');
    expect(r.translatedFrom).toBeUndefined();
  });

  test('fetch flow with a fake YouTube', async () => {
    const calls: string[] = [];
    const fake = async (url: string) => {
      calls.push(url);
      if (url.includes('/player')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=x&fmt=srv3', languageCode: 'en', kind: 'asr' }] } } }) };
      }
      return { ok: true, status: 200, text: async () => xml };
    };
    const r = await fetchYouTubeCaptions('jNQXAC9IVRw', fake);
    expect(r).toMatchObject({ language: 'en', kind: 'asr' });
    expect(r.segments).toHaveLength(2);
    expect(calls[1]).toMatch(/&fmt=srv3$/);
    expect(calls[1]).not.toContain('fmt=srv3&');
  });

  test('videos without captions fail honestly', async () => {
    const none = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ playabilityStatus: { status: 'OK' } }) });
    await expect(fetchYouTubeCaptions('x', none)).rejects.toMatchObject({ code: 'NO_TRACKS' });
    const priv = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Private video' } }) });
    await expect(fetchYouTubeCaptions('x', priv)).rejects.toMatchObject({ code: 'UNPLAYABLE', message: 'Private video' });
  });
});

describe('keyword highlights', () => {
  const segs = [
    { startMs: 0, endMs: 1000, text: 'Today we set up Claude Code hooks for the project.' },
    { startMs: 5000, endMs: 6000, text: 'Hooks run before every tool call, so hooks can block bad commands.' },
    { startMs: 9000, endMs: 10000, text: 'Configure hooks in settings and test the hooks with a dry run.' },
  ];

  test('tools first, then frequent meaningful terms, each with real timestamps', () => {
    const k = extractKeywords(segs, { tools: ['Claude Code'], title: 'Claude Code hooks' });
    expect(k[0]).toMatchObject({ term: 'Claude Code', isTool: true, count: 1 });
    const hooks = k.find((x) => x.term === 'hooks');
    expect(hooks?.count).toBe(5);
    expect(hooks?.moments.map((m) => m.startMs)).toEqual([0, 5000, 9000]);
    expect(k.find((x) => x.term === 'the')).toBeUndefined();
  });

  test('recurring two-word phrases beat their single words, filler never surfaces', () => {
    const talk = [
      { startMs: 0, endMs: 1000, text: 'Really, guys, this video is actually about the vector database thing.' },
      { startMs: 4000, endMs: 5000, text: 'A vector database stores embeddings. People really love it, actually.' },
      { startMs: 8000, endMs: 9000, text: 'Gonna show how embeddings get queried, really fast, guys.' },
    ];
    const terms = extractKeywords(talk).map((k) => k.term);
    expect(terms).toContain('vector database');
    expect(terms).toContain('embeddings');
    expect(terms).not.toContain('vector');
    expect(terms).not.toContain('database');
    for (const filler of ['really', 'guys', 'actually', 'video', 'gonna', 'thing', 'people']) expect(terms).not.toContain(filler);
  });

  test('model concepts come first but only when they occur in the text; capped at 8', () => {
    const k = extractKeywords(segs, { concepts: ['dry run', 'quantum computing'], tools: ['Claude Code'] });
    expect(k.map((x) => x.term)).toEqual(expect.arrayContaining(['Claude Code', 'dry run']));
    expect(k.find((x) => x.term === 'quantum computing')).toBeUndefined();
    expect(k.find((x) => x.term === 'dry run')).toMatchObject({ count: 1, moments: [{ startMs: 9000 }] });
    const many = Array.from({ length: 12 }, (_, i) => `alpha${i} beta${i} alpha${i} beta${i}`).join('. ');
    expect(extractKeywords([{ startMs: null, endMs: null, text: many }]).length).toBeLessThanOrEqual(8);
  });

  test('splitHighlights marks whole-word matches only', () => {
    expect(splitHighlights('Hooks and webhooks; hooks!', ['hooks'])).toEqual([
      { text: 'Hooks', hit: true }, { text: ' and webhooks; ', hit: false }, { text: 'hooks', hit: true }, { text: '!', hit: false },
    ]);
    expect(splitHighlights('nothing here', [])).toEqual([{ text: 'nothing here', hit: false }]);
  });
});

describe('website text', () => {
  test('readable text keeps the article and drops chrome', () => {
    const html = `<html><head><script>var x=1</script><style>p{}</style></head><body>
      <nav><p>Home About Pricing and other navigation links here</p></nav>
      <article><h1>Building agents</h1><p>Agents call tools in a loop until the task is done.</p>
      <ul><li>Validate every tool input before execution.</li></ul><pre>npm install agent-kit</pre>
      <p>Share</p></article><footer><p>© 2026 Some company footer text that is long enough.</p></footer></body></html>`;
    expect(extractReadableText(html)).toBe('Building agents\n\nAgents call tools in a loop until the task is done.\n\n• Validate every tool input before execution.\n\nnpm install agent-kit');
  });

  test('X oEmbed blockquote becomes plain text', () => {
    expect(htmlToText('<blockquote><p lang="en">Shipping hooks today &amp; more<br>details soon</p></blockquote>')).toBe('Shipping hooks today & more\ndetails soon');
  });
});

test('words that appear once (e.g. in a short post) are not highlighted as keywords', () => {
  const k = extractKeywords([{ startMs: null, endMs: null, text: 'Are you sure you made the right choice? Find out in theaters.' }], { title: 'Are you sure you made the right choice' });
  expect(k).toEqual([]);
});

test('article extraction stops at references and strips citation markers', () => {
  const html = '<article><p>Knowledge management is a discipline about organising what people know.[12]</p><h2>References</h2><ul><li>Smith (2009). doi:10.1/x</li></ul><p>After refs paragraph that should be dropped entirely.</p></article>';
  expect(extractReadableText(html)).toBe('Knowledge management is a discipline about organising what people know.');
});

test('attribute contents never leak into article text (Wikipedia data-mw holds raw ">")', () => {
  const html = `<article><table data-mw='{"parts":[{"wt":"* <small>Anonymous, 1827</small>\\n* [[Elephas]]"}]}' class="infobox"><tr><td>Infobox</td></tr></table>`
    + '<p data-x="a > b" id=lead>Elephants are the largest living land animals on Earth today.</p>'
    + '<ul><li data-mw="{&quot;wt&quot;:&quot;x&quot;} > <small>">Elephants live in herds led by an older female.</li></ul></article>';
  const text = extractReadableText(html);
  expect(text).toBe('Elephants are the largest living land animals on Earth today.\n\n• Elephants live in herds led by an older female.');
  expect(htmlToText('<span title="1 > 0">ok</span>')).toBe('ok');
});

test('keyword moments in untimed text are the sentences that mention the term', () => {
  const k = extractKeywords([{ startMs: null, endMs: null, text: 'Intro sentence here. Agents call tools often. Nothing else. Agents stop when done.' }]);
  const agents = k.find((x) => x.term === 'agents');
  expect(agents?.moments.map((m) => m.text)).toEqual(['Agents call tools often.', 'Agents stop when done.']);
});

test('README text decodes HTML entities like &middot; (seen in GitHub summaries)', () => {
  const { stripMarkdown } = require('../../src/core/metadata');
  expect(stripMarkdown('Website &middot; Docs &middot; API &mdash; fast &amp; small')).toBe('Website · Docs · API — fast & small');
});
