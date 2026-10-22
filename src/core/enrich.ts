/**
 * Local, deterministic knowledge extraction (no AI model required).
 *
 * Everything here is *evidence-derived*: commands, URLs and repositories are
 * copied verbatim from the source text, and the summary is extractive (real
 * sentences from the source). Results are labelled origin 'local' so the UI can
 * distinguish them from model-generated interpretations.
 * Extracted commands are NEVER executed.
 */

import { analyzeUrl, extractUrls } from './url';

export const ENRICHMENT_VERSION = 1;

export interface ExtractedCommand {
  command: string;
  destructive: boolean;
  reason?: string;
}

/** A key point, optionally anchored to the transcript moment it comes from. */
export interface KeyMoment {
  text: string;
  startMs: number | null;
}

export interface Enrichment {
  origin: 'local' | 'model' | 'server';
  version: number;
  provider: string;
  generatedAt: string;
  summary: string;
  /** One-sentence summary. Absent on enrichments stored before 1.4. */
  tldr?: string;
  keyPoints: string[];
  /** Key points with their real segment start. Absent on enrichments stored before 1.4. */
  keyMoments?: KeyMoment[];
  concepts: string[];
  tools: string[];
  commands: ExtractedCommand[];
  repos: string[];
  urls: string[];
  tags: string[];
  followUpQuestions: string[];
  actionItems: string[];
  timestamps: { ms: number; label: string }[];
}

const CLI_PREFIXES = [
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'node', 'deno', 'pip', 'pip3', 'pipx', 'uv', 'uvx', 'python', 'python3',
  'poetry', 'conda', 'git', 'gh', 'docker', 'docker-compose', 'kubectl', 'helm', 'terraform', 'brew', 'apt', 'apt-get',
  'sudo', 'curl', 'wget', 'cargo', 'rustup', 'go', 'make', 'cmake', 'claude', 'expo', 'eas', 'flutter', 'dart',
  'gradle', './gradlew', 'mvn', 'java', 'ollama', 'aws', 'gcloud', 'az', 'firebase', 'vercel', 'netlify', 'supabase',
  'ssh', 'scp', 'chmod', 'chown', 'rm', 'mv', 'cp', 'mkdir', 'cd', 'ls', 'cat', 'export', 'source', 'psql', 'mysql',
  'redis-cli', 'mongosh', 'composer', 'php', 'ruby', 'gem', 'bundle', 'rails', 'dotnet', 'swift', 'xcodebuild', 'adb',
];

const DESTRUCTIVE: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, 'Recursively/forcibly deletes files'],
  [/\bdd\s+if=/, 'Writes raw data to a device or file'],
  [/\bmkfs(\.\w+)?\b/, 'Formats a filesystem'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'Fork bomb'],
  [/\bchmod\s+(-R\s+)?777\b/, 'Makes files world-writable'],
  [/\bgit\s+push\b.*(--force|-f\b)/, 'Force-pushes and can overwrite remote history'],
  [/\bgit\s+reset\s+--hard\b/, 'Discards local changes'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'Deletes untracked files'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, 'Deletes database objects'],
  [/\bdelete\s+from\s+\w+\s*(;|$)/i, 'Deletes all rows from a table'],
  [/(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, 'Pipes a remote script directly into a shell'],
  [/\bsudo\b/, 'Runs with administrator privileges'],
  [/\bkubectl\s+delete\b/, 'Deletes Kubernetes resources'],
  [/\bterraform\s+destroy\b/, 'Destroys infrastructure'],
  [/\bdocker\s+(system|volume|image)\s+prune\b/, 'Deletes Docker data'],
  [/>\s*\/dev\/sd[a-z]/, 'Overwrites a disk device'],
];

const TOOL_DICTIONARY = [
  'Claude Code', 'Claude', 'Anthropic', 'OpenAI', 'ChatGPT', 'GPT-4', 'Gemini', 'Llama', 'Mistral', 'Ollama', 'LangChain',
  'LangGraph', 'LlamaIndex', 'CrewAI', 'AutoGen', 'MCP', 'Model Context Protocol', 'Cursor', 'Copilot', 'Windsurf',
  'React', 'React Native', 'Expo', 'Next.js', 'Vue', 'Svelte', 'Angular', 'Remix', 'Astro', 'Vite', 'Webpack', 'Tailwind',
  'TypeScript', 'JavaScript', 'Python', 'Rust', 'Golang', 'Kotlin', 'Swift', 'Java', 'Dart', 'Flutter', 'Node.js', 'Deno', 'Bun',
  'FastAPI', 'Django', 'Flask', 'Express', 'NestJS', 'Spring Boot', 'Rails', 'Laravel',
  'PostgreSQL', 'Postgres', 'MySQL', 'SQLite', 'MongoDB', 'Redis', 'Supabase', 'Firebase', 'Prisma', 'Drizzle',
  'Docker', 'Kubernetes', 'Terraform', 'AWS', 'GCP', 'Azure', 'Vercel', 'Netlify', 'Cloudflare', 'GitHub Actions',
  'Git', 'GitHub', 'GitLab', 'VS Code', 'Neovim', 'Jest', 'Vitest', 'Playwright', 'Cypress', 'Detox', 'Whisper',
  'Hugging Face', 'PyTorch', 'TensorFlow', 'pandas', 'NumPy', 'Kafka', 'RabbitMQ', 'GraphQL', 'gRPC', 'REST',
  'WebSocket', 'Figma', 'Notion', 'Obsidian', 'Zod', 'tRPC', 'Redux', 'Zustand', 'React Query', 'TanStack',
];

// Names that are also everyday English words only match when capitalised as a proper noun.
const CASE_SENSITIVE = new Set([
  'Claude', 'Gemini', 'Llama', 'Mistral', 'Cursor', 'Copilot', 'Windsurf', 'React', 'Expo', 'Vue', 'Remix', 'Astro',
  'Express', 'Rails', 'Swift', 'Rust', 'Dart', 'Bun', 'Deno', 'Git', 'REST', 'MCP', 'AWS', 'GCP', 'Jest', 'Kafka',
  'Redis', 'Prisma', 'Drizzle', 'Zod', 'Redux', 'Zustand', 'Whisper', 'Figma', 'Notion', 'Obsidian', 'Flask', 'Spring Boot',
]);

const STOP = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both
but by can could did do does doing down during each few for from further had has have having he her here hers him his
how i if in into is it its itself just let like me more most my no nor not now of off on once only or other our ours out
over own really same she should so some such than that the their them then there these they this those through to too
under until up very was we were what when where which while who whom why will with would you your yours yourself going
get got make made one two use used using want way thing things lot gonna yeah okay ok right know think see go also just
here's there's it's don't i'm you're we're they're that's let's video today guys hey welcome thanks thank`.split(/\s+/),
);

const ACTION_RE = /\b(you should|make sure to|remember to|don't forget to|try to|need to|first,|next,|then,|finally,|step \d+)/i;

/** Key points with timestamps when known; older enrichments only stored plain strings. */
export function keyMomentsOf(e: Pick<Enrichment, 'keyPoints' | 'keyMoments'> | null | undefined): KeyMoment[] {
  if (!e) return [];
  if (e.keyMoments?.length) return e.keyMoments;
  return (e.keyPoints ?? []).map((p) => (typeof p === 'string' ? { text: p, startMs: null } : (p as KeyMoment)));
}

export function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^.{20,}?[.!?](?=\s|$)/.exec(t);
  return m ? m[0] : t;
}

export function detectDestructive(command: string): { destructive: boolean; reason?: string } {
  for (const [re, reason] of DESTRUCTIVE) if (re.test(command)) return { destructive: true, reason };
  return { destructive: false };
}

export function extractCommands(text: string): ExtractedCommand[] {
  const out: ExtractedCommand[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const cmd = raw.replace(/^\s*[$>#]\s+/, '').replace(/\s+/g, ' ').trim().replace(/[.,;]$/, '');
    if (cmd.length < 3 || cmd.length > 300 || seen.has(cmd)) return;
    const first = cmd.split(' ')[0];
    if (!CLI_PREFIXES.includes(first)) return;
    if (cmd.split(' ').length < 2 && !['make', 'ls'].includes(first)) return;
    seen.add(cmd);
    out.push({ command: cmd, ...detectDestructive(cmd) });
  };
  for (const m of text.matchAll(/`([^`\n]{3,300})`/g)) add(m[1]);
  for (const m of text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)) for (const line of m[1].split('\n')) add(line);
  for (const line of text.split('\n')) if (/^\s*[$>]\s+\S/.test(line)) add(line);
  // Spoken transcripts: "run npm install expo-sqlite"
  for (const m of text.matchAll(/\b(?:run|type|execute|install with|use)\s+((?:npx|npm|pip|git|docker|claude|brew|uvx|pnpm|yarn|bun|cargo|kubectl)\s+[^\n.,;]{2,120})/gi)) add(m[1]);
  return out.slice(0, 50);
}

export function extractRepos(text: string): string[] {
  const repos = new Set<string>();
  for (const u of extractUrls(text)) {
    const info = analyzeUrl(u);
    if (info?.githubRepo) repos.add(info.githubRepo);
  }
  for (const m of text.matchAll(/\bgithub\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)) {
    const info = analyzeUrl(`https://github.com/${m[1]}`);
    if (info?.githubRepo) repos.add(info.githubRepo);
  }
  return [...repos].slice(0, 50);
}

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+(?:com|org|io|dev|net|app|ai|co|so|sh)(?:\/\S*)?/gi;

/** Text without web addresses: "github.com/x/y" is a link, not a mention of GitHub. */
export function stripUrls(text: string): string {
  return text.replace(URL_RE, ' ');
}

export function extractTools(raw: string): string[] {
  const text = stripUrls(raw);
  const found: string[] = [];
  for (const tool of TOOL_DICTIONARY) {
    const esc = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^A-Za-z0-9])${esc}(?![A-Za-z0-9])`, CASE_SENSITIVE.has(tool) ? '' : 'i');
    if (re.test(text)) found.push(tool);
  }
  // Drop a shorter name when a longer one that contains it was found ("Claude" vs "Claude Code").
  return found.filter((t) => !found.some((o) => o !== t && o.toLowerCase().includes(t.toLowerCase())));
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{1,40}/g) ?? [])
    .map((w) => w.replace(/[.-]+$/, ''))
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
}

export function keywordScores(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of tokenize(text)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return counts;
}

export function suggestTags(text: string, tools: string[], max = 6): string[] {
  const tags: string[] = tools.slice(0, 3).map((t) => t.toLowerCase().replace(/\s+/g, '-'));
  const ranked = [...keywordScores(text).entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  for (const [w] of ranked) {
    if (tags.length >= max) break;
    if (!tags.includes(w) && !tags.some((t) => t.includes(w))) tags.push(w);
  }
  return tags;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25 && s.length <= 400);
}

/** Extractive summary: highest-scoring real sentences, in original order. */
export function extractiveSummary(text: string, maxSentences = 3): { summary: string; keyPoints: string[] } {
  const sentences = splitSentences(text);
  if (!sentences.length) {
    const t = text.replace(/\s+/g, ' ').trim();
    return { summary: t.length > 280 ? `${t.slice(0, 277)}…` : t, keyPoints: [] };
  }
  const scores = keywordScores(text);
  const ranked = sentences
    .map((s, i) => {
      const words = tokenize(s);
      const score = words.reduce((acc, w) => acc + Math.log(1 + (scores.get(w) ?? 0)), 0) / Math.sqrt(words.length + 1);
      return { s, i, score };
    })
    .sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, maxSentences).sort((a, b) => a.i - b.i);
  const points = ranked.slice(0, 6).sort((a, b) => a.i - b.i).map((r) => r.s);
  return { summary: top.map((t) => t.s).join(' '), keyPoints: points };
}

export interface EnrichInput {
  title: string;
  url?: string | null;
  note: string;
  bodyText: string; // transcript / description / pasted text
  timedSegments?: { startMs: number | null; text: string }[];
  now: string;
}

export function localEnrich(input: EnrichInput): Enrichment {
  const all = [input.title, input.note, input.bodyText].filter(Boolean).join('\n');
  const tools = extractTools(all);
  const commands = extractCommands(all);
  const repos = extractRepos([input.url ?? '', all].join('\n'));
  const urls = extractUrls(all).slice(0, 30);
  const { summary, keyPoints } = extractiveSummary(input.bodyText || input.note || input.title);
  const actionItems = splitSentences(input.bodyText).filter((s) => ACTION_RE.test(s)).slice(0, 8);
  const scores = keywordScores(all);
  const concepts = [...scores.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);
  const timed = (input.timedSegments ?? []).filter((s): s is { startMs: number; text: string } => s.startMs !== null);
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  // Extractive key points are real sentences, so the segment that contains their opening words is where they were said.
  const keyMoments: KeyMoment[] = keyPoints.map((p) => {
    const head = flat(p).slice(0, 25);
    return { text: p, startMs: timed.find((s) => flat(s.text).includes(head))?.startMs ?? null };
  });
  const timestamps: { ms: number; label: string }[] = [];
  if (input.timedSegments?.length) {
    const kp = new Set(keyPoints.map((p) => p.slice(0, 40)));
    for (const seg of input.timedSegments) {
      if (seg.startMs === null) continue;
      if ([...kp].some((p) => seg.text.includes(p.slice(0, 25))) || tools.some((t) => seg.text.includes(t))) {
        timestamps.push({ ms: seg.startMs, label: seg.text.slice(0, 120) });
      }
      if (timestamps.length >= 8) break;
    }
  }
  return {
    origin: 'local',
    version: ENRICHMENT_VERSION,
    provider: 'qivra-local-extractive',
    generatedAt: input.now,
    summary,
    tldr: firstSentence(summary),
    keyPoints,
    keyMoments,
    concepts,
    tools,
    commands,
    repos,
    urls,
    tags: suggestTags(all, tools),
    followUpQuestions: [],
    actionItems,
    timestamps,
  };
}
