/**
 * Durable processing pipeline.
 *
 * Every unit of work is a row in the `jobs` table (idempotent id), claimed
 * atomically, retried with backoff and recovered after process death. The
 * runner is driven by app start/resume, by captures, and by the
 * WorkManager-backed background task (see background.ts).
 */

import { localEnrich, type Enrichment } from '../core/enrich';
import { enrichmentPrompt, mergeModelEnrichment, parseModelEnrichment } from '../core/enrichModel';
import { detectLanguage, languageName } from '../core/language';
import { isIndianLanguage, parseSummaryTranslation, parseTranslationBatch, summaryTranslationMessages, TRANSLATION_BATCH, translationMessages, type IndianLanguage, type SummaryTranslation } from '../core/translate';
import { keyMomentsOf } from '../core/enrich';
import { fetchMetadata, stripMarkdown } from '../core/metadata';
import { pickXVideo, xSyndicationUrl } from '../core/socialMedia';
import { ProviderError, type ChatProvider } from '../core/ai/provider';
import { isFailed, type ItemStatus } from '../core/status';
import { analyzeUrl, ARTICLE_SOURCES, VIDEO_SOURCES } from '../core/url';
import { CaptionsUnavailable, fetchYouTubeCaptions } from '../core/youtubeCaptions';
import type { Repo } from '../db/repo';
import type { Item, Job, Transcript } from '../db/types';
import { aiInfo, loadEmbedder, loadProvider } from './ai';
import { getRepo } from './db';
import { fetchText } from './http';
import { emit } from './events';
import { generateReport } from './reports';
import { CloudWhisperError, cloudWhisperReady, deleteCached, downloadToCache, transcribeMedia, WHISPER_MODEL } from './cloudWhisper';
import { DownloadError, downloadReelAudio } from './downloader';
import { ocrItemImages, ocrVideoFrames } from './ocr';
import { deleteSecret, SECRET_KEYS } from './secure';
import { getSettings } from './settings';

class JobError extends Error {
  constructor(public code: string, message: string, public retryable: boolean) {
    super(message);
  }
}

const VIDEO_LIKE = new Set<string>(VIDEO_SOURCES);
const NETWORK_RETRY_MS = 60_000;
/** A job that is waiting for the phone to be online again (does not use up attempts). */
const WAITING_FOR_NETWORK = 'WAITING_FOR_NETWORK';

/** Make jobs that wait for the internet due now (called when the app comes back to the foreground). */
export async function wakeWaitingJobs(repo: Repo): Promise<void> {
  await repo.db.run(`UPDATE jobs SET run_after = ? WHERE status = 'queued' AND last_error_code = ?`, [new Date().toISOString(), WAITING_FOR_NETWORK]);
}

/**
 * Qivra 2.2 runs entirely on the phone. Installs that were paired with the old laptop server:
 * forget the pairing (the server is not contacted), drop server and sync jobs, and re-run items
 * that were waiting for the server so they use Groq on the phone instead. Runs once.
 */
export async function removeServerOnce(repo: Repo): Promise<number> {
  if ((await repo.getMeta('app.serverRemoved')) === '1') return 0;
  await deleteSecret(SECRET_KEYS.deviceToken).catch(() => undefined);
  await repo.setMeta('server.connection', 'null');
  await repo.setMeta('sync.enabled', '0');
  await repo.db.run(`DELETE FROM jobs WHERE kind LIKE 'server\\_%' ESCAPE '\\' OR kind = 'sync'`);
  await repo.db.run(`UPDATE items SET sync_status = 'local_only' WHERE sync_status != 'local_only'`);
  const stuck = await repo.db.all<{ id: string }>(
    `SELECT id FROM items WHERE deleted = 0 AND (status = 'TRANSCRIBING' OR (status = 'NEEDS_INPUT' AND error_code IN ('SERVER_NOT_PAIRED','SERVER_UNREACHABLE','SERVER_FAILED','SERVER_OUTDATED','TRANSCRIPT_MISSING','TRANSCRIPTION_REQUIRED')))`,
  );
  await repo.setMeta('app.serverRemoved', '1');
  for (const r of stuck) await schedulePipeline(r.id);
  return stuck.length;
}

/** Move an item through the state machine, tolerating repeated runs. */
async function moveTo(repo: Repo, item: Item, to: ItemStatus, error?: { code: string; message: string } | null): Promise<Item> {
  if (item.status === to && !error) return item;
  const next = await repo.setStatus(item.id, to, error ?? null);
  emit('items');
  return next ?? item;
}

/** Re-process GitHub items saved before READMEs were kept as Markdown (runs once per item). */
export async function upgradeOldReadmes(): Promise<number> {
  const ids = await (await getRepo()).oldReadmeItemIds();
  for (const id of ids) await schedulePipeline(id);
  return ids.length;
}

/** Schedule (or re-run) local processing for an item. */
export async function schedulePipeline(itemId: string, opts: { force?: boolean } = {}): Promise<void> {
  const repo = await getRepo();
  void opts;
  await repo.enqueueJob({ id: `job_local_enrich_${itemId}`, kind: 'local_enrich', itemId, retry: true, maxAttempts: 3 });
  emit('jobs');
  void runDueJobs();
}

async function sourceText(repo: Repo, item: Item): Promise<{ body: string; timed: { startMs: number | null; text: string }[]; hasSpeech: boolean }> {
  // Qivra works in English: summaries, keywords and flashcards read the English transcripts (Kannada, Hindi,
  // Telugu and Tamil translations are views made from them). A not-yet-translated original is used until then.
  const all = (await repo.listTranscripts(item.id)).filter((t) => t.kind === 'original' || t.language === 'en');
  const transcripts = all.some((t) => t.language === 'en') ? all.filter((t) => t.language === 'en' || ARTICLE_SOURCES.has(t.source)) : all;
  const timed: { startMs: number | null; text: string }[] = [];
  // Markdown (GitHub READMEs) is read as plain text for summaries and keywords.
  const plain = (t: { format: string | null }, text: string) => (t.format === 'md' ? stripMarkdown(text) : text);
  for (const t of transcripts.slice(0, 2)) for (const s of await repo.getSegments(t.id)) timed.push({ startMs: s.startMs, text: plain(t, s.text) });
  const parts = [...transcripts.map((t) => plain(t, t.text)), item.metadata?.description ?? ''];
  const meta = item.metadata as (Item['metadata'] & { bodyText?: string }) | null;
  if (meta?.bodyText) parts.push(meta.bodyText);
  return { body: parts.filter(Boolean).join('\n\n'), timed, hasSpeech: all.some((t) => !ARTICLE_SOURCES.has(t.source)) };
}

async function handleLocalEnrich(repo: Repo, job: Job): Promise<Record<string, unknown>> {
  let item = await repo.getItem(job.itemId ?? '');
  if (!item || item.deleted) throw new JobError('ITEM_NOT_FOUND', 'Item was deleted.', false);
  if (item.status === 'CANCELLED') return { skipped: 'cancelled' };
  if (item.status === 'READY' || isFailed(item.status) || item.status === 'NEEDS_INPUT') item = await moveTo(repo, item, 'METADATA_CHECK');
  if (item.status === 'CAPTURED') item = await moveTo(repo, item, 'METADATA_CHECK');

  // 1. Metadata (best effort; failure is recorded but does not fail the item).
  // A README saved before 1.9.3 was plain text; fetch it again once as Markdown.
  const oldReadme = (await repo.listTranscripts(item.id)).find((t) => t.source === 'github_readme' && t.format !== 'md');
  if (item.url && (!item.metadata || oldReadme)) {
    const info = analyzeUrl(item.url);
    if (info) {
      try {
        const meta = await fetchMetadata(info, fetchText);
        if (meta) {
          item = (await repo.updateItem(item.id, {
            metadata: { title: meta.title, description: meta.description, siteName: meta.siteName, imageUrl: meta.imageUrl, author: meta.author, fetchedAt: new Date().toISOString(), provider: meta.provider },
            title: item.title || meta.title,
            author: item.author || meta.author,
            siteName: meta.siteName,
            thumbnailUrl: item.thumbnailUrl || meta.imageUrl,
          })) ?? item;
          // Website article text / GitHub README become an "article" record: searchable, highlightable, summarised.
          if (meta.bodyText && (item.sourceType === 'web' || item.sourceType === 'github')) {
            const lang = oldReadme ? { code: oldReadme.language } : detectLanguage(meta.bodyText);
            await repo.upsertTranscript({
              itemId: item.id, language: lang.code, languageMethod: 'heuristic', kind: 'original',
              source: item.sourceType === 'github' ? 'github_readme' : 'web_article', provider: meta.provider, format: meta.markdown ? 'md' : 'txt',
              segments: [{ startMs: null, endMs: null, text: meta.markdown || meta.bodyText }],
            });
          }
        } else if (!item.metadata) {
          // Only mark "unavailable" the first time: a failed refetch (e.g. GitHub's rate limit) keeps what was saved.
          item = (await repo.updateItem(item.id, { metadata: { fetchedAt: new Date().toISOString(), provider: 'unavailable' } })) ?? item;
        }
      } catch {
        // Offline or blocked: leave metadata empty so a later run can try again.
      }
    }
  }

  // 2. Text in shared screenshots/photos (on-device OCR) — before enrichment so summaries and search use it.
  const ocr = item.sourceType === 'note' ? await ocrItemImages(repo, item) : 'no_images';

  // 3. Speech transcript for video posts: YouTube captions on the phone, otherwise the paired server.
  let src = await sourceText(repo, item);
  if (VIDEO_LIKE.has(item.sourceType) && !src.hasSpeech) {
    const outcome = await obtainTranscript(repo, item);
    if (outcome === 'stored') src = await sourceText(repo, item);
    else {
      await enrichAndIndex(repo, item, src.body, src.timed, false);
      const cur = (await repo.getItem(item.id))!;
      if (outcome.kind === 'waiting') {
        await moveTo(repo, cur, 'TRANSCRIBING', { code: 'INFO_TRANSCRIBING', message: outcome.message });
        return { status: 'TRANSCRIBING' };
      }
      if (outcome.kind === 'no_speech') {
        // Nothing to transcribe (music-only reel, image post, text-only tweet): finish with what the post says.
        await moveTo(repo, cur, 'ENRICHING');
        await enrichAndIndex(repo, (await repo.getItem(item.id))!, src.body, src.timed, true);
        await repo.db.run('UPDATE items SET error_code = ?, error_message = ? WHERE id = ?', ['INFO_NO_SPEECH', outcome.message, item.id]);
        emit('items');
        return { status: 'READY', note: 'no_speech' };
      }
      await moveTo(repo, cur, 'NEEDS_INPUT', { code: outcome.code, message: outcome.message });
      return { status: 'NEEDS_INPUT' };
    }
  }
  if (item.sourceType === 'file' && !src.hasSpeech && (await repo.listMedia(item.id)).some((m) => /^(audio|video)\//.test(m.mime))) {
    await enrichAndIndex(repo, item, src.body, src.timed, false);
    // No server: transcribe the file on the phone with the user's Groq key.
    const cloud = await cloudDecision(repo, item);
    if (cloud.kind === 'waiting') {
      await moveTo(repo, (await repo.getItem(item.id))!, 'TRANSCRIBING', { code: 'INFO_TRANSCRIBING', message: cloud.message });
      return { status: 'TRANSCRIBING' };
    }
    await moveTo(repo, (await repo.getItem(item.id))!, 'NEEDS_INPUT', {
      code: cloud.kind === 'failed' ? cloud.code : 'TRANSCRIPTION_REQUIRED',
      message: cloud.kind === 'failed' ? cloud.message : 'This media file needs a transcript. Add your Groq key in Settings → AI models to transcribe it on the phone, or import a transcript.',
    });
    return { status: 'NEEDS_INPUT' };
  }
  item = await moveTo(repo, item, 'ENRICHING');
  await enrichAndIndex(repo, item, src.body, src.timed, true);
  if (ocr === 'unavailable' || ocr === 'no_text') {
    const message = ocr === 'no_text' ? 'No text was found in this image.' : 'Text recognition is not available in this build, so the image text is not searchable yet.';
    await repo.db.run('UPDATE items SET error_code = ?, error_message = ? WHERE id = ?', [ocr === 'no_text' ? 'INFO_NO_TEXT' : 'INFO_OCR_UNAVAILABLE', message, item.id]);
    emit('items');
  }
  return { status: 'READY', ...(ocr === 'no_images' ? {} : { ocr }) };
}

type TranscriptOutcome =
  | 'stored'
  | { kind: 'waiting'; message: string }
  | { kind: 'no_speech'; message: string }
  | { kind: 'needs_input'; code: string; message: string };

const NO_SPEECH_CODES = new Set(['NO_SPEECH', 'NO_AUDIO', 'NO_MEDIA_IN_POST']);

async function obtainTranscript(repo: Repo, item: Item): Promise<TranscriptOutcome> {
  // A video file attached to the post (e.g. the reel the user downloaded in Instagram) is transcribed directly.
  if ((await repo.listMedia(item.id)).some((m) => /^(audio|video)\//.test(m.mime))) {
    const cloud = await cloudDecision(repo, item);
    if (cloud.kind === 'waiting') return cloud;
    if (cloud.kind === 'failed') {
      if (NO_SPEECH_CODES.has(cloud.code)) return { kind: 'no_speech', message: cloud.message };
      return { kind: 'needs_input', code: cloud.code, message: NEEDS_KEY_CODES.includes(cloud.code) ? cloud.message : `${cloud.message} You can import a transcript instead.` };
    }
    if (!(await cloudWhisperReady())) return { kind: 'needs_input', code: 'NO_TRANSCRIBER', message: 'Add your free Groq key in Settings → AI models to transcribe the attached video.' };
  }
  let captionNote = '';
  if (item.sourceType === 'youtube' && item.url) {
    const videoId = analyzeUrl(item.url)?.youtubeId;
    if (videoId) {
      try {
        // English captions, or YouTube's own translation into English; any other language is translated by Groq later.
        const caps = await fetchYouTubeCaptions(videoId, fetch as never, ['en']);
        await repo.upsertTranscript({
          itemId: item.id, language: caps.language, languageMethod: 'provider', kind: 'original', source: 'youtube_captions',
          provider: caps.translatedFrom ? `youtube-auto-translated (${caps.translatedFrom})` : caps.kind === 'asr' ? 'youtube-auto-captions' : 'youtube-captions', format: 'srv3', segments: caps.segments,
        });
        return 'stored';
      } catch (e) {
        captionNote = e instanceof CaptionsUnavailable ? e.message : 'Could not reach YouTube for captions.';
      }
    }
  }
  // YouTube cuts off audio downloads by apps (only its own apps may stream it), so without captions a
  // transcript has to be imported. Captions are tried first, above.
  if (item.sourceType === 'youtube') {
    return {
      kind: 'needs_input', code: 'YOUTUBE_NO_CAPTIONS',
      message: `${captionNote || 'This video has no captions on YouTube.'} YouTube doesn't let apps download its audio, so import a transcript (or the video file, if you have it).`,
    };
  }
  const settings = await getSettings();
  // X videos and Instagram reels (downloaded with yt-dlp on the phone) are transcribed with the user's Groq key.
  if (settings.autoTranscribe && CLOUD_TRANSCRIBABLE.has(item.sourceType)) {
    const cloud = await cloudDecision(repo, item);
    if (cloud.kind === 'waiting') return cloud;
    if (cloud.kind === 'failed') {
      if (NO_SPEECH_CODES.has(cloud.code)) return { kind: 'no_speech', message: cloud.message };
      // A missing or rejected key: ask for it (saving a key re-runs this item, see retryItemsNeedingKey).
      if (NEEDS_KEY_CODES.includes(cloud.code)) return { kind: 'needs_input', code: cloud.code, message: cloud.message };
      // The post text is still worth keeping when the video could not be transcribed.
      if (((await repo.getItem(item.id))?.metadata?.description ?? '').trim()) return { kind: 'no_speech', message: `${cloud.message} Using the post text.` };
      return { kind: 'needs_input', code: cloud.code, message: `${cloud.message} You can import a transcript instead.` };
    }
  }
  const groq = await cloudWhisperReady();
  if (item.sourceType === 'x' && (item.metadata?.description ?? '').trim() && groq) return { kind: 'no_speech', message: 'Using the post text.' };
  return {
    kind: 'needs_input',
    code: groq ? 'TRANSCRIPT_MISSING' : 'NO_TRANSCRIBER',
    message: groq
      ? 'Import a transcript (SRT, VTT, TXT) or paste one.'
      : 'Add your free Groq key in Settings → AI models to transcribe videos on the phone, or import a transcript.',
  };
}

const CLOUD_TRANSCRIBABLE = new Set(['x', 'instagram']);

/** Whether a phone-side Groq transcription is running, can start now, or already failed for this item. */
async function cloudDecision(repo: Repo, item: Item): Promise<{ kind: 'waiting'; message: string } | { kind: 'failed'; code: string; message: string } | { kind: 'unavailable' }> {
  const id = `job_cloud_transcribe_${item.id}`;
  const job = await repo.getJob(id);
  if (job?.status === 'failed_permanent') return { kind: 'failed', code: job.lastErrorCode ?? 'TRANSCRIBE_FAILED', message: job.lastError ?? 'Transcription failed.' };
  if (job && ['queued', 'running', 'failed_retryable'].includes(job.status)) {
    return { kind: 'waiting', message: job.lastErrorCode === WAITING_FOR_NETWORK ? 'Waiting for internet…' : 'Transcribing with Groq Whisper…' };
  }
  if (job?.status === 'succeeded' || !(await cloudWhisperReady())) return { kind: 'unavailable' };
  await repo.enqueueJob({ id, kind: 'cloud_transcribe', itemId: item.id, retry: true, maxAttempts: 3 });
  emit('jobs');
  return { kind: 'waiting', message: 'Transcribing with Groq Whisper…' };
}

/** The video (and post text) of a shared X post, from X's public embed source. */
async function findPostVideo(item: Item): Promise<{ url: string | null; durationMs: number | null; caption: string | null }> {
  const info = item.url ? analyzeUrl(item.url) : null;
  if (item.sourceType === 'x' && info?.xStatusId) {
    const r = await fetchText(xSyndicationUrl(info.xStatusId), { accept: 'application/json', timeoutMs: 15_000 });
    if (!r.ok) throw new JobError('POST_UNAVAILABLE', r.status === 404 ? 'This post is private or was deleted.' : `X did not return the post (${r.status}).`, r.status === 429 || r.status >= 500);
    const json = JSON.parse(r.text) as { text?: string };
    const v = pickXVideo(json);
    return { url: v?.url ?? null, durationMs: v?.durationMs ?? null, caption: typeof json.text === 'string' ? json.text : null };
  }
  return { url: null, durationMs: null, caption: null };
}

/** Phone-only transcription with the user's Groq key: the post's video, or an imported audio/video file. */
async function handleCloudTranscribe(repo: Repo, job: Job): Promise<Record<string, unknown> | 'offline'> {
  const item = await repo.getItem(job.itemId ?? '');
  if (!item || item.deleted) throw new JobError('ITEM_NOT_FOUND', 'Item was deleted.', false);
  let file: { uri: string; mime: string; name: string; temp: boolean } | null = null;
  let durationMs: number | null = null;
  try {
    // An attached file (imported media, or a downloaded reel added to its Instagram item) comes first.
    const m = (await repo.listMedia(item.id)).find((x) => /^(audio|video)\//.test(x.mime));
    if (m) {
      file = { uri: m.uri, mime: m.mime, name: m.name, temp: false };
    } else if (item.sourceType === 'file') {
      throw new JobError('NO_MEDIA', 'Attach an audio or video file first.', false);
    } else if (item.sourceType === 'instagram' && item.url) {
      const d = await downloadReelAudio(item.url).catch((e) => {
        if (!(e instanceof DownloadError)) throw e;
        if (e.code === 'OFFLINE') throw new CloudWhisperError('OFFLINE', e.message, true);
        throw new JobError(e.code === 'BLOCKED' ? 'INSTAGRAM_BLOCKED' : e.code === 'TOO_LARGE' ? 'FILE_TOO_LARGE' : e.code === 'UNAVAILABLE' ? 'DOWNLOADER_UNAVAILABLE' : 'DOWNLOAD_FAILED', e.message, e.code === 'FAILED');
      });
      file = { uri: d.uri, mime: d.mime, name: d.uri.split('/').pop() ?? 'reel.m4a', temp: true };
      durationMs = d.durationMs;
      if (d.description && !(item.metadata?.description ?? '').trim()) {
        await repo.updateItem(item.id, { metadata: { ...(item.metadata ?? {}), description: d.description, fetchedAt: new Date().toISOString(), provider: 'yt-dlp' } });
      }
    } else {
      const found = await findPostVideo(item);
      if (found.caption && !(item.metadata?.description ?? '').trim()) {
        await repo.updateItem(item.id, { metadata: { ...(item.metadata ?? {}), description: found.caption, fetchedAt: new Date().toISOString(), provider: item.metadata?.provider ?? 'embed' } });
      }
      if (!found.url) throw new JobError('NO_MEDIA_IN_POST', 'No video in this post.', false);
      durationMs = found.durationMs;
      file = { uri: await downloadToCache(found.url, `${item.id}.mp4`), mime: 'video/mp4', name: 'video.mp4', temp: true };
    }
    const r = await transcribeMedia(file.uri, file.mime, file.name);
    if (!r.noSpeech) {
      const text = r.segments.map((s) => s.text).join(' ');
      await repo.upsertTranscript({
        itemId: item.id, language: r.language === 'und' ? detectLanguage(text).code : r.language, languageMethod: r.language === 'und' ? 'heuristic' : 'provider',
        kind: 'original', source: 'cloud_whisper', provider: `groq-${WHISPER_MODEL}`, format: null, segments: r.segments,
      });
    } else if (!(/^video\//.test(file.mime) && (await ocrVideoFrames(repo, item.id, file.uri, r.durationMs ?? durationMs ?? 0)))) {
      throw new JobError('NO_SPEECH', 'No speech in this video.', false);
    }
  } catch (e) {
    // No connection (fetch throws a TypeError, a timeout aborts): wait for the internet instead of failing.
    if ((e instanceof CloudWhisperError && e.code === 'OFFLINE') || e instanceof TypeError || (e as Error)?.name === 'AbortError') {
      await repo.db.run('UPDATE items SET error_message = ? WHERE id = ?', ['Waiting for internet…', item.id]);
      emit('items');
      return 'offline';
    }
    if (e instanceof CloudWhisperError) throw new JobError(e.code, e.message, e.retryable);
    if (e instanceof JobError) throw e;
    // Anything else (an unreadable reply, a full disk): use up an attempt and end with a message, never wait forever.
    throw new JobError('INTERNAL', (e as Error)?.message || 'Transcription failed.', true);
  } finally {
    if (file?.temp) await deleteCached(file.uri);
  }
  await schedulePipeline(item.id);
  return { transcribed: true };
}

async function enrichAndIndex(repo: Repo, item: Item, body: string, timed: { startMs: number | null; text: string }[], finish: boolean): Promise<void> {
  const now = new Date().toISOString();
  const local = localEnrich({ title: item.title, url: item.url, note: item.note, bodyText: body, timedSegments: timed, now });
  // Keep a newer model/server enrichment; refresh evidence fields from the local pass.
  const prev = item.enrichment;
  const enrichment: Enrichment = prev && prev.origin !== 'local' ? { ...prev, tools: local.tools, commands: local.commands, repos: local.repos, urls: local.urls, timestamps: local.timestamps } : local;
  const lang = item.languageMethod === 'user' ? null : detectLanguage([item.title, item.note, body].join(' '));
  await repo.updateItem(item.id, {
    enrichment,
    ...(item.summaryOrigin === 'none' || item.summaryOrigin === 'local' ? { summary: enrichment.summary, summaryOrigin: enrichment.origin === 'local' ? 'local' : 'model' } : {}),
    ...(lang && lang.code !== 'und' ? { language: lang.code, languageMethod: 'heuristic' as const } : {}),
  });
  if (!item.tags.length && enrichment.tags.length) {
    for (const t of enrichment.tags.slice(0, 4)) await repo.addTag(item.id, t, 'suggested');
    await repo.reindexMeta(item.id);
  }
  if (!finish) return;
  let cur = (await repo.getItem(item.id))!;
  cur = await moveTo(repo, cur, 'INDEXING');
  await repo.reindexMeta(cur.id);
  await moveTo(repo, cur, 'READY');
  if (item.url && (item.sourceType === 'web' || item.sourceType === 'github') && !(await repo.listTranscripts(item.id)).length && !item.note) {
    await repo.db.run('UPDATE items SET error_code = ?, error_message = ? WHERE id = ?', [
      'INFO_UNREADABLE', 'Qivra could not read this page (the site may block apps or need JavaScript). Open the original, or add a note.', item.id,
    ]);
  }
  if (await repo.syncEnabled()) await repo.enqueueJob({ id: 'job_sync', kind: 'sync', retry: true, maxAttempts: 6 });
  const ai = await aiInfo();
  // A non-English transcript is translated first; the summary is then made from the English text.
  if (ai.enabled && (await untranslatedTranscript(repo, item.id))) {
    await repo.enqueueJob({ id: `job_translate_${item.id}`, kind: 'translate', itemId: item.id, retry: true, maxAttempts: 6 });
  } else if (ai.enabled && ai.autoEnrich) await repo.enqueueJob({ id: `job_model_enrich_${item.id}`, kind: 'model_enrich', itemId: item.id, retry: true, maxAttempts: 3 });
  if (ai.embeddingModel) await repo.enqueueJob({ id: 'job_embed', kind: 'embed', retry: true, maxAttempts: 3 });
}

/** The speech transcript still to be translated to English, if any (one that failed for good is not retried). */
async function untranslatedTranscript(repo: Repo, itemId: string): Promise<Transcript | null> {
  const all = await repo.listTranscripts(itemId);
  if (all.some((t) => t.kind === 'translation' && t.language === 'en')) return null;
  if ((await repo.getJob(`job_translate_${itemId}`))?.status === 'failed_permanent') return null;
  return all.find((t) => t.kind === 'original' && !ARTICLE_SOURCES.has(t.source) && t.language !== 'en'
    && (t.language !== 'und' || detectLanguage(t.text).code !== 'en') && t.text.trim().length > 0) ?? null;
}

/**
 * Translate segment texts batch by batch, saving progress under `progressKey` so a rate limit or a lost
 * connection resumes where it stopped. Returns 'offline' when the connection dropped.
 */
async function translateLines(repo: Repo, provider: ChatProvider, texts: string[], from: string, to: string, progressKey: string): Promise<string[] | 'offline'> {
  const done = await repo.getJson<string[]>(progressKey, []);
  try {
    for (let i = done.length; i < texts.length; i += TRANSLATION_BATCH) {
      const lines = texts.slice(i, i + TRANSLATION_BATCH);
      const res = await provider.chat(translationMessages(lines, from, to), { temperature: 0, maxTokens: 4000 });
      await repo.addUsage({ provider: provider.label, model: res.model, kind: 'translate', promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens });
      const out = parseTranslationBatch(res.content, lines.length);
      if (!out) throw new JobError('BAD_MODEL_OUTPUT', 'The translation did not come back line by line.', true);
      done.push(...out);
      await repo.setJson(progressKey, done);
    }
  } catch (e) {
    if (e instanceof JobError) throw e;
    if ((e instanceof ProviderError && (e.code === 'NETWORK' || e.code === 'TIMEOUT')) || e instanceof TypeError) return 'offline';
    if (e instanceof ProviderError) throw new JobError(e.code, e.message, e.retryable);
    throw new JobError('INTERNAL', (e as Error)?.message || 'Translation failed.', true);
  }
  await repo.setJson(progressKey, null);
  return done;
}

/** Translate a speech transcript to English (timestamps kept); the English text then replaces the original. */
async function handleTranslate(repo: Repo, job: Job): Promise<Record<string, unknown> | 'offline'> {
  const item = await repo.getItem(job.itemId ?? '');
  if (!item || item.deleted) throw new JobError('ITEM_NOT_FOUND', 'Item was deleted.', false);
  const t = await untranslatedTranscript(repo, item.id);
  if (!t) return { skipped: 'nothing to translate' };
  const { provider, reason } = await loadProvider();
  if (!provider) throw new JobError('NO_PROVIDER', reason ?? 'No AI provider configured.', false);
  const segs = await repo.getSegments(t.id);
  const done = await translateLines(repo, provider, segs.map((s) => s.text), t.language === 'und' ? '' : languageName(t.language), 'en', `translate.progress.${t.id}`);
  if (done === 'offline') return 'offline';
  await repo.upsertTranscript({
    itemId: item.id, language: 'en', languageMethod: 'provider', kind: 'translation', source: 'ai_translation', provider: provider.label, format: t.format,
    segments: segs.map((s, k) => ({ startMs: s.startMs, endMs: s.endMs, text: done[k] })),
  });
  await repo.deleteTranscript(t.id); // Qivra keeps transcripts in English only
  await schedulePipeline(item.id); // summary, keywords and flashcards from the English text
  return { translated: segs.length, from: t.language };
}

/** Meta key of an item's summary translated into an Indian language. */
export const summaryTranslationKey = (itemId: string, lang: IndianLanguage) => `translation.${lang}.${itemId}`;

/** Translate an item's English transcript and summary into Kannada, Hindi, Telugu or Tamil (on request). */
async function handleTranslateTo(repo: Repo, job: Job): Promise<Record<string, unknown> | 'offline'> {
  const item = await repo.getItem(job.itemId ?? '');
  if (!item || item.deleted) throw new JobError('ITEM_NOT_FOUND', 'Item was deleted.', false);
  const lang = String(job.payload?.lang ?? '');
  if (!isIndianLanguage(lang)) throw new JobError('BAD_LANGUAGE', `Qivra translates into Kannada, Hindi, Telugu and Tamil, not "${lang}".`, false);
  const { provider, reason } = await loadProvider();
  if (!provider) throw new JobError('NO_PROVIDER', reason ?? 'No AI provider configured.', false);
  const all = await repo.listTranscripts(item.id);
  const en = all.find((t) => t.language === 'en' && !ARTICLE_SOURCES.has(t.source)) ?? all.find((t) => t.language === 'en');
  if (en && !all.some((t) => t.kind === 'translation' && t.language === lang)) {
    const segs = await repo.getSegments(en.id);
    const done = await translateLines(repo, provider, segs.map((s) => s.text), 'English', lang, `translate.progress.${en.id}.${lang}`);
    if (done === 'offline') return 'offline';
    await repo.upsertTranscript({
      itemId: item.id, language: lang, languageMethod: 'provider', kind: 'translation', source: 'ai_translation', provider: provider.label, format: en.format,
      segments: segs.map((s, k) => ({ startMs: s.startMs, endMs: s.endMs, text: done[k] })),
    });
    emit('items');
  }
  const e = item.enrichment;
  const src: SummaryTranslation = { tldr: e?.tldr || item.summary, summary: e?.summary || item.summary, moments: keyMomentsOf(e).map((m) => ({ text: m.text, startMs: m.startMs })) };
  if (src.tldr.trim() || src.summary.trim()) {
    try {
      const res = await provider.chat(summaryTranslationMessages(src, lang), { temperature: 0, maxTokens: 3000 });
      await repo.addUsage({ provider: provider.label, model: res.model, kind: 'translate', promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens });
      const out = parseSummaryTranslation(res.content, src);
      if (!out) throw new JobError('BAD_MODEL_OUTPUT', 'The summary translation came back in the wrong shape.', true);
      await repo.setJson(summaryTranslationKey(item.id, lang), out);
    } catch (err) {
      if (err instanceof JobError) throw err;
      if ((err instanceof ProviderError && (err.code === 'NETWORK' || err.code === 'TIMEOUT')) || err instanceof TypeError) return 'offline';
      if (err instanceof ProviderError) throw new JobError(err.code, err.message, err.retryable);
      throw new JobError('INTERNAL', (err as Error)?.message || 'Translation failed.', true);
    }
  }
  emit('items');
  return { lang, transcript: !!en };
}

/** Ask for an item in Kannada, Hindi, Telugu or Tamil (needs the user's AI key). */
export async function requestTranslation(itemId: string, lang: IndianLanguage): Promise<void> {
  const repo = await getRepo();
  await repo.enqueueJob({ id: `job_translate_to_${lang}_${itemId}`, kind: 'translate_to', itemId, payload: { lang }, retry: true, maxAttempts: 6 });
  emit('jobs');
  void runDueJobs();
}

/**
 * Qivra 2.3 keeps transcripts in English only. Once: drop originals that already have an English
 * translation, and queue translation for other non-English speech transcripts.
 */
export async function englishOnlyOnce(repo: Repo): Promise<number> {
  if ((await repo.getMeta('app.englishOnly')) === '1') return 0;
  const rows = await repo.db.all<{ item_id: string }>(`SELECT DISTINCT item_id FROM transcripts WHERE language != 'en'`);
  let queued = 0;
  for (const { item_id } of rows) {
    const all = await repo.listTranscripts(item_id);
    if (all.some((t) => t.kind === 'translation' && t.language === 'en')) {
      for (const t of all) if (t.kind === 'original' && t.language !== 'en' && !ARTICLE_SOURCES.has(t.source)) await repo.deleteTranscript(t.id);
    } else if (await untranslatedTranscript(repo, item_id)) {
      await repo.enqueueJob({ id: `job_translate_${item_id}`, kind: 'translate', itemId: item_id, retry: true, maxAttempts: 6 });
      queued++;
    }
  }
  await repo.setMeta('app.englishOnly', '1');
  return queued;
}

async function handleModelEnrich(repo: Repo, job: Job): Promise<Record<string, unknown>> {
  const item = await repo.getItem(job.itemId ?? '');
  if (!item || item.deleted) throw new JobError('ITEM_NOT_FOUND', 'Item was deleted.', false);
  const { provider, reason } = await loadProvider();
  if (!provider) throw new JobError('NO_PROVIDER', reason ?? 'No AI provider configured.', false);
  const { body, timed } = await sourceText(repo, item);
  try {
    const description = item.metadata?.description ?? '';
    const prompt = enrichmentPrompt({ title: item.title, url: item.url, note: item.note, body, timed, description });
    const res = await provider.chat([{ role: 'user', content: prompt }], { maxTokens: 2500 }); // room for reasoning models to think, then answer
    await repo.addUsage({ provider: provider.label, model: res.model, kind: 'enrich', promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens });
    const evidence = {
      text: [item.title, item.note, body, description].join('\n'),
      segmentStarts: timed.flatMap((t) => (t.startMs === null ? [] : [t.startMs])),
    };
    const parsed = parseModelEnrichment(res.content, evidence);
    if (!parsed) throw new JobError('BAD_MODEL_OUTPUT', 'The model did not return valid JSON.', true);
    const now = new Date().toISOString();
    const local = item.enrichment ?? localEnrich({ title: item.title, note: item.note, bodyText: body, timedSegments: timed, now });
    const merged = mergeModelEnrichment(local, parsed, provider.label, now);
    await repo.updateItem(item.id, { enrichment: merged, ...(item.summaryOrigin !== 'user' ? { summary: merged.tldr || merged.summary, summaryOrigin: 'model' as const } : {}) });
    emit('items');
    return { provider: provider.label };
  } catch (e) {
    if (e instanceof JobError) throw e;
    if (e instanceof ProviderError) throw new JobError(e.code, e.message, e.retryable);
    throw new JobError('PROVIDER_FAILED', String((e as Error).message ?? e), true);
  }
}

async function handleEmbed(repo: Repo): Promise<Record<string, unknown>> {
  const { provider, reason, embeddingModel } = await loadEmbedder();
  if (!provider?.embed || !embeddingModel) throw new JobError('NO_PROVIDER', reason ?? 'No embedding model configured.', false);
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const batch = await repo.chunksMissingEmbeddings(embeddingModel, 16);
    if (!batch.length) break;
    try {
      const vectors = await provider.embed(batch.map((b) => b.text));
      await repo.saveEmbeddings(embeddingModel, batch.map((b, j) => ({ chunkId: b.id, vector: vectors[j] })));
      total += batch.length;
    } catch (e) {
      if (e instanceof ProviderError) throw new JobError(e.code, e.message, e.retryable);
      throw e;
    }
  }
  return { embedded: total };
}

async function handleScheduledReport(): Promise<Record<string, unknown>> {
  const s = await getSettings();
  if (!s.scheduledDailyReport) return { skipped: true };
  const r = await generateReport({ kind: 'yesterday' });
  return { reportId: r.id };
}

let running = false;

/**
 * Re-queue jobs left 'running' by a killed process, but only when no job loop is
 * active in this JS context (the open app may be running one right now).
 */
export async function recoverIfIdle(): Promise<number> {
  if (running) return 0;
  return (await getRepo()).recoverRunningJobs();
}

/** Claim and execute due jobs. Safe to call often; only one loop runs per JS context. */
export async function runDueJobs(budgetMs = 25_000): Promise<number> {
  if (running) return 0;
  running = true;
  const deadline = Date.now() + budgetMs;
  let done = 0;
  try {
    const repo = await getRepo();
    while (Date.now() < deadline) {
      const jobs = await repo.claimDueJobs(3);
      if (!jobs.length) break;
      for (const job of jobs) {
        try {
          let result: Record<string, unknown> | 'offline';
          switch (job.kind) {
            case 'local_enrich':
            case 'index':
              result = await handleLocalEnrich(repo, job);
              break;
            case 'model_enrich':
              result = await handleModelEnrich(repo, job);
              break;
            case 'embed':
              result = await handleEmbed(repo);
              break;
            case 'server_metadata':
            case 'server_captions':
            case 'server_transcribe':
            case 'server_transcribe_url':
            case 'server_enrich':
            case 'sync':
              result = { skipped: 'server removed' }; // left over from the laptop server, which the app no longer uses
              break;
            case 'cloud_transcribe':
              result = await handleCloudTranscribe(repo, job);
              break;
            case 'translate':
              result = await handleTranslate(repo, job);
              break;
            case 'translate_to':
              result = await handleTranslateTo(repo, job);
              break;
            case 'scheduled_report':
              result = await handleScheduledReport();
              break;
            default:
              throw new JobError('UNKNOWN_JOB', `Unknown job ${job.kind}`, false);
          }
          if (result === 'offline') {
            // Try again later without consuming an attempt (and at once when the app is opened, see bootstrap.onResume).
            await repo.db.run(`UPDATE jobs SET status = 'queued', attempts = attempts - 1, run_after = ?, last_error_code = ?, last_error = ? WHERE id = ?`, [
              new Date(Date.now() + NETWORK_RETRY_MS).toISOString(), WAITING_FOR_NETWORK, 'Waiting for internet.', job.id,
            ]);
          } else await repo.completeJob(job.id, result);
        } catch (e) {
          const err = e instanceof JobError ? e : new JobError('INTERNAL', (e as Error)?.message ?? 'Unexpected error', true);
          const updated = await repo.failJob(job.id, { code: err.code, message: err.message, retryable: err.retryable });
          // A finally-failed server transcription hands the item back to the local pipeline to decide its end state.
          if (job.kind === 'cloud_transcribe' && job.itemId && updated?.status === 'failed_permanent') await schedulePipeline(job.itemId);
          if (job.itemId && (job.kind === 'local_enrich' || job.kind === 'index')) {
            const item = await repo.getItem(job.itemId);
            if (item && !item.deleted) {
              const to = updated?.status === 'failed_retryable' ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT';
              await repo.setStatus(item.id, to, { code: err.code, message: err.message }).catch(() => undefined);
            }
          }
        }
        done++;
        emit('jobs', 'items');
      }
    }
  } finally {
    running = false;
    await scheduleNextRun();
  }
  return done;
}

let wakeTimer: ReturnType<typeof setTimeout> | null = null;

/** While work is waiting (server polling, backoff), wake the runner when the next job becomes due. */
async function scheduleNextRun(): Promise<void> {
  try {
    const repo = await getRepo();
    const next = await repo.db.get<{ t: string }>(`SELECT MIN(run_after) AS t FROM jobs WHERE status IN ('queued','failed_retryable')`);
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
    if (!next?.t) return;
    const delay = Math.min(60_000, Math.max(1_000, Date.parse(next.t) - Date.now()));
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      void runDueJobs();
    }, delay);
  } catch {
    /* the next app resume or background task will pick the work up */
  }
}

/** Codes for "no transcriber was set up" (or the key was rejected), so a newly added key can fix them. */
const NEEDS_KEY_CODES = ['NO_TRANSCRIBER', 'SERVER_NOT_PAIRED', 'NO_PROVIDER', 'AUTH'];

/** After the user adds an AI key: re-run items that stopped because no working key was set up. */
export async function retryItemsNeedingKey(): Promise<number> {
  const repo = await getRepo();
  const marks = NEEDS_KEY_CODES.map(() => '?').join(',');
  const rows = await repo.db.all<{ id: string }>(`SELECT id FROM items WHERE deleted = 0 AND status = 'NEEDS_INPUT' AND error_code IN (${marks})`, NEEDS_KEY_CODES);
  // A phone transcription that failed for want of a key would otherwise be reported again instead of retried.
  await repo.db.run(`DELETE FROM jobs WHERE kind = 'cloud_transcribe' AND status = 'failed_permanent' AND last_error_code IN (${marks})`, NEEDS_KEY_CODES);
  for (const r of rows) await schedulePipeline(r.id);
  return rows.length;
}

export async function requestModelEnrichment(itemId: string): Promise<void> {
  const repo = await getRepo();
  await repo.enqueueJob({ id: `job_model_enrich_${itemId}`, kind: 'model_enrich', itemId, retry: true, maxAttempts: 3 });
  emit('jobs');
  void runDueJobs();
}

export async function cancelItemProcessing(itemId: string): Promise<void> {
  const repo = await getRepo();
  for (const j of await repo.listJobs({ itemId, statuses: ['queued', 'running', 'failed_retryable'] })) await repo.cancelJob(j.id);
  const item = await repo.getItem(itemId);
  if (item && item.status !== 'READY' && item.status !== 'CANCELLED') await repo.setStatus(itemId, 'CANCELLED').catch(() => undefined);
  emit('jobs', 'items');
}
