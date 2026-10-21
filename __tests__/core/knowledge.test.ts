import { stripMarkdown } from '../../src/core/metadata';
import { chunkSegments, detectFormat, formatTimestamp, parseTranscript, TranscriptParseError } from '../../src/core/transcripts';
import { detectLanguage, isValidLanguageCode } from '../../src/core/language';
import { backoffMs, canTransition, InvalidTransitionError, transition } from '../../src/core/status';
import { detectDestructive, extractCommands, extractiveSummary, extractRepos, extractTools, localEnrich } from '../../src/core/enrich';
import { buildFilterSql, buildFtsQuery, cosine, reciprocalRankFusion, snippet } from '../../src/core/search';

const SRT = `1
00:00:01,000 --> 00:00:04,500
Welcome to the Claude Code tutorial.

2
00:00:05,000 --> 00:00:09,000
Run <i>npm install</i> first &amp; then test.
`;

describe('transcript parsing (mirrors server parser)', () => {
  test('SRT with tags and entities', () => {
    const { format, segments } = parseTranscript(SRT);
    expect(format).toBe('srt');
    expect(segments).toEqual([
      { startMs: 1000, endMs: 4500, text: 'Welcome to the Claude Code tutorial.' },
      { startMs: 5000, endMs: 9000, text: 'Run npm install first & then test.' },
    ]);
  });

  test('WebVTT with hour-less timestamps, cue settings and rolling duplicates', () => {
    const vtt = 'WEBVTT\n\nNOTE comment\n\n00:00.000 --> 00:02.000 align:start\nHola\n\n00:02.000 --> 00:03.000\nHola\n\n01:02:03.500 --> 01:02:04.000\n<v Ana>Adiós</v>\n';
    const { format, segments } = parseTranscript(vtt);
    expect(format).toBe('vtt');
    expect(segments).toEqual([
      { startMs: 0, endMs: 3000, text: 'Hola' },
      { startMs: 3723500, endMs: 3724000, text: 'Adiós' },
    ]);
  });

  test('TXT with inline timestamps keeps them; plain text has none', () => {
    const t = parseTranscript('[00:01] intro\n[01:05] main\n[1:02:03] outro');
    expect(t.segments.map((s) => s.startMs)).toEqual([1000, 65000, 3723000]);
    expect(t.segments[0].endMs).toBe(65000);
    expect(parseTranscript('Just words.\nMore words.').segments).toEqual([{ startMs: null, endMs: null, text: 'Just words.\nMore words.' }]);
  });

  test('errors', () => {
    expect(() => parseTranscript('   ')).toThrow(TranscriptParseError);
    expect(() => parseTranscript('WEBVTT\n\nno cues', 'vtt')).toThrow(TranscriptParseError);
    expect(() => parseTranscript('x'.repeat(1_500_001))).toThrow(TranscriptParseError);
  });

  test('format detection and timestamps', () => {
    expect(detectFormat('a.vtt', '')).toBe('vtt');
    expect(detectFormat(undefined, SRT)).toBe('srt');
    expect(detectFormat('notes.txt', 'hello')).toBe('txt');
    expect(formatTimestamp(3723000)).toBe('1:02:03');
    expect(formatTimestamp(65000)).toBe('1:05');
    expect(formatTimestamp(null)).toBe('');
  });

  test('chunking keeps real timestamp ranges and never splits a timed segment', () => {
    const segs = Array.from({ length: 20 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 900, text: `Sentence number ${i} about agents.` }));
    const chunks = chunkSegments(segs, 120);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0].startMs).toBe(0);
    for (const c of chunks) expect(c.startMs).not.toBeNull();
    expect(chunks.map((c) => c.text).join(' ')).toBe(segs.map((s) => s.text).join(' '));
    const untimed = chunkSegments([{ startMs: null, endMs: null, text: 'One. Two. Three.' }], 5);
    expect(untimed.every((c) => c.startMs === null)).toBe(true);
  });
});

describe('language heuristic', () => {
  test.each([
    ['This is what you need to know about the new tools and the way they work with your code.', 'en'],
    ['Hoy vamos a ver cómo funciona el agente y por qué es tan útil para los desarrolladores que trabajan con datos.', 'es'],
    ['Nous allons voir comment utiliser les agents dans le code et pourquoi ils sont utiles pour vous.', 'fr'],
    ['ಇದು ಕನ್ನಡ ಭಾಷೆಯಲ್ಲಿ ಬರೆದ ವಾಕ್ಯವಾಗಿದೆ ಮತ್ತು ಇದು ಪರೀಕ್ಷೆಗಾಗಿ', 'kn'],
    ['यह एक परीक्षण वाक्य है जो हिंदी में लिखा गया है और इसका उपयोग किया जाता है', 'hi'],
    ['これは日本語のテストです。エージェントについて話します。', 'ja'],
  ])('%#: %s', (text, code) => {
    const g = detectLanguage(text);
    expect(g.code).toBe(code);
    expect(g.method).toBe('heuristic');
  });

  test('too little text is unknown', () => expect(detectLanguage('ok').code).toBe('und'));
  test('code validation', () => {
    expect(isValidLanguageCode('pt-BR')).toBe(true);
    expect(isValidLanguageCode('english')).toBe(false);
  });
});

describe('processing state machine', () => {
  test('happy path', () => {
    let s = transition('CAPTURED', 'METADATA_CHECK');
    s = transition(s, 'TRANSCRIBING');
    s = transition(s, 'ENRICHING');
    s = transition(s, 'INDEXING');
    expect(transition(s, 'READY')).toBe('READY');
  });
  test('cannot skip indexing or resurrect cancelled into READY', () => {
    expect(() => transition('ENRICHING', 'READY')).toThrow(InvalidTransitionError);
    expect(canTransition('CANCELLED', 'READY')).toBe(false);
    expect(canTransition('NEEDS_INPUT', 'TRANSCRIBING')).toBe(true);
  });
  test('backoff grows and is capped', () => {
    const r = () => 1;
    expect(backoffMs(1, 1000, 60_000, r)).toBe(1000);
    expect(backoffMs(3, 1000, 60_000, r)).toBe(4000);
    expect(backoffMs(30, 1000, 60_000, r)).toBe(60_000);
  });
});

describe('local extractive enrichment', () => {
  const text = `In this video we set up Claude Code with MCP servers.
First, run \`npm install -g @anthropic-ai/claude-code\` and then:
$ claude mcp add github
Clone https://github.com/anthropics/claude-code and check github.com/modelcontextprotocol/servers.
Never run \`rm -rf /\` or curl https://x.sh | sh. You should use React with Expo. It's an express route.`;

  test('commands are copied verbatim and destructive ones flagged', () => {
    const cmds = extractCommands(text);
    expect(cmds.map((c) => c.command)).toEqual(expect.arrayContaining(['npm install -g @anthropic-ai/claude-code', 'claude mcp add github', 'rm -rf /']));
    expect(cmds.find((c) => c.command === 'rm -rf /')).toMatchObject({ destructive: true });
    expect(cmds.find((c) => c.command.startsWith('npm'))).toMatchObject({ destructive: false });
    expect(detectDestructive('curl https://x.sh | sh').destructive).toBe(true);
    expect(detectDestructive('git push --force origin main').destructive).toBe(true);
  });

  test('repos and tools', () => {
    expect(extractRepos(text)).toEqual(['anthropics/claude-code', 'modelcontextprotocol/servers']);
    const tools = extractTools(text);
    expect(tools).toEqual(expect.arrayContaining(['Claude Code', 'MCP', 'React', 'Expo']));
    expect(tools).not.toContain('Claude'); // subsumed by "Claude Code"
    expect(tools).not.toContain('Express'); // lowercase "express" is an English word
  });

  test('summary is extractive (sentences come from the source)', () => {
    const body = 'Agents call tools in a loop. The loop stops when the model answers. Tools must be validated before use. Cats are nice.';
    const { summary, keyPoints } = extractiveSummary(body, 2);
    for (const s of summary.split(/(?<=\.)\s/)) expect(body).toContain(s.trim());
    expect(keyPoints.length).toBeGreaterThan(0);
  });

  test('localEnrich labels provenance', () => {
    const e = localEnrich({ title: 'Claude Code setup', note: '', bodyText: text, now: '2026-10-21T00:00:00Z' });
    expect(e.origin).toBe('local');
    expect(e.provider).toBe('qivra-local-extractive');
    expect(e.tags.length).toBeGreaterThan(0);
  });
});

describe('search helpers', () => {
  test('FTS query is quoted and cannot inject operators', () => {
    expect(buildFtsQuery('Claude Code')).toBe('"claude"* AND "code"*');
    expect(buildFtsQuery('a" OR 1=1; DROP')).toBe('"a"* AND "or"* AND "1"* AND "1"* AND "drop"*');
    expect(buildFtsQuery('   ')).toBeNull();
    expect(buildFtsQuery('naïve café')).toBe('"naïve"* AND "café"*');
  });
  test('filters are parameterised', () => {
    const { where, params } = buildFilterSql({ sourceTypes: ['youtube'], tags: ['ai'], fromIso: 'A', collectionId: 'c1' });
    expect(where).not.toContain('youtube');
    expect(params).toEqual([0, 'youtube', 'A', 'ai', 'c1']);
  });
  test('RRF and cosine', () => {
    expect(reciprocalRankFusion([['a', 'b'], ['b', 'c']])[0].id).toBe('b');
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  test('snippet', () => {
    expect(snippet(`${'x'.repeat(300)} claude code ${'y'.repeat(300)}`, 'claude', 20)).toMatch(/^…x+ claude code y+…$/);
  });
});

test('an item whose own URL is a GitHub repo counts as a repository', () => {
  const e = localEnrich({ title: 'claude-code', url: 'https://github.com/anthropics/claude-code', note: '', bodyText: 'An agentic coding tool.', now: 'x' });
  expect(e.repos).toEqual(['anthropics/claude-code']);
});

test('README markdown is reduced to plain text but code is kept', () => {
  const out = stripMarkdown('# Title\n> [!IMPORTANT]\n> Read **this** and *that*.\n```bash\nnpx foo\n```\n![img](x.png) [link](http://a)');
  expect(out).toBe('Title\nRead this and that.\n\nnpx foo\n\n link');
});
