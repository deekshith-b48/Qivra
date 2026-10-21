/**
 * Durable processing pipeline.
 *
 * Every unit of work is a row in the `jobs` table (idempotent id), claimed
 * atomically, retried with backoff and recovered after process death. The
 * runner is driven by app start/resume, by captures, and by the
 * WorkManager-backed background task (see background.ts).
 */

import { ApiError } from '../core/api';
import { localEnrich, type Enrichment } from '../core/enrich';
import { enrichmentPrompt, mergeModelEnrichment, parseModelEnrichment } from '../core/enrichModel';
import { detectLanguage } from '../core/language';
import { fetchMetadata } from '../core/metadata';
import { ProviderError } from '../core/ai/provider';
import { isFailed, type ItemStatus } from '../core/status';
import { analyzeUrl } from '../core/url';
import type { Repo } from '../db/repo';
import type { Item, Job } from '../db/types';
import { runSync } from '../sync/engine';
import { loadProvider } from './ai';
import { getRepo } from './db';
import { emit } from './events';
import { getClient, getConnection } from './server';
import { generateReport } from './reports';
import { getSettings } from './settings';

class JobError extends Error {
  constructor(public code: string, message: string, public retryable: boolean) {
    super(message);
  }
}

const VIDEO_LIKE = new Set(['youtube', 'instagram', 'podcast']);

async function fetchText(url: string, opts: { accept: string; timeoutMs: number }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: opts.accept }, signal: ctl.signal });
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > 3_000_000) return { ok: false, status: 413, text: '', contentType: '' };
    return { ok: res.ok, status: res.status, text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
  } finally {
    clearTimeout(t);
  }
}

/** Move an item through the state machine, tolerating repeated runs. */
async function moveTo(repo: Repo, item: Item, to: ItemStatus, error?: { code: string; message: string } | null): Promise<Item> {
  if (item.status === to && !error) return item;
  const next = await repo.setStatus(item.id, to, error ?? null);
  emit('items');
  return next ?? item;
}

/** Schedule (or re-run) local processing for an item. */
export async function schedulePipeline(itemId: string, opts: { force?: boolean } = {}): Promise<void> {
  const repo = await getRepo();
  await repo.enqueueJob({ id: `job_local_enrich_${itemId}`, kind: 'local_enrich', itemId, retry: true, maxAttempts: 3, ...(opts.force ? {} : {}) });
  emit('jobs');
  void runDueJobs();
}

async function sourceText(repo: Repo, item: Item): Promise<{ body: string; timed: { startMs: number | null; text: string }[]; hasTranscript: boolean }> {
  const transcripts = (await repo.listTranscripts(item.id)).filter((t) => t.kind === 'original');
  const timed: { startMs: number | null; text: string }[] = [];
  for (const t of transcripts.slice(0, 2)) for (const s of await repo.getSegments(t.id)) timed.push({ startMs: s.startMs, text: s.text });
  const parts = [...transcripts.map((t) => t.text), item.metadata?.description ?? ''];
  const meta = item.metadata as (Item['metadata'] & { bodyText?: string }) | null;
  if (meta?.bodyText) parts.push(meta.bodyText);
  return { body: parts.filter(Boolean).join('\n\n'), timed, hasTranscript: transcripts.length > 0 };
}

async function handleLocalEnrich(repo: Repo, job: Job): Promise<Record<string, unknown>> {
  let item = await repo.getItem(job.itemId ?? '');
  if (!item || item.deleted) throw new JobError('ITEM_NOT_FOUND', 'Item was deleted.', false);
  if (item.status === 'CANCELLED') return { skipped: 'cancelled' };
  if (item.status === 'READY' || isFailed(item.status) || item.status === 'NEEDS_INPUT') item = await moveTo(repo, item, 'METADATA_CHECK');
  if (item.status === 'CAPTURED') item = await moveTo(repo, item, 'METADATA_CHECK');

  // 1. Metadata (best effort; failure is recorded but does not fail the item).
  if (item.url && !item.metadata) {
    const info = analyzeUrl(item.url);
    if (info) {
      try {
        const meta = await fetchMetadata(info, fetchText);
        if (meta) {
          item = (await repo.updateItem(item.id, {
            metadata: { title: meta.title, description: meta.description, siteName: meta.siteName, imageUrl: meta.imageUrl, author: meta.author, fetchedAt: new Date().toISOString(), provider: meta.provider, ...(meta.bodyText ? { bodyText: meta.bodyText } : {}) } as Item['metadata'],
            title: item.title || meta.title,
            author: item.author || meta.author,
            siteName: meta.siteName,
            thumbnailUrl: item.thumbnailUrl || meta.imageUrl,
          })) ?? item;
        } else {
          item = (await repo.updateItem(item.id, { metadata: { fetchedAt: new Date().toISOString(), provider: 'unavailable' } })) ?? item;
        }
      } catch {
        // Offline or blocked: leave metadata empty so a later run can try again.
      }
    }
  }

  // 2. Transcript gate for video/audio sources.
  const { body, timed, hasTranscript } = await sourceText(repo, item);
  if (VIDEO_LIKE.has(item.sourceType) && !hasTranscript) {
    await enrichAndIndex(repo, item, body, timed, false);
    await moveTo(repo, (await repo.getItem(item.id))!, 'NEEDS_INPUT', {
      code: 'TRANSCRIPT_MISSING',
      message: 'No transcript yet. Import captions/subtitles (SRT, VTT, TXT), paste one, or ask your server to fetch captions.',
    });
    return { status: 'NEEDS_INPUT' };
  }
  if (item.sourceType === 'file' && !hasTranscript && (await repo.listMedia(item.id)).length) {
    await enrichAndIndex(repo, item, body, timed, false);
    await moveTo(repo, (await repo.getItem(item.id))!, 'NEEDS_INPUT', {
      code: 'TRANSCRIPTION_REQUIRED',
      message: 'This media file needs a transcript. Import one, or send it to your paired server for transcription.',
    });
    return { status: 'NEEDS_INPUT' };
  }
  item = await moveTo(repo, item, 'ENRICHING');
  await enrichAndIndex(repo, item, body, timed, true);
  return { status: 'READY' };
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
  const s = await getSettings();
  if (s.ai.enabled && s.ai.autoEnrich) await repo.enqueueJob({ id: `job_model_enrich_${item.id}`, kind: 'model_enrich', itemId: item.id, retry: true, maxAttempts: 3 });
  if (s.ai.enabled && s.ai.embeddingModel) await repo.enqueueJob({ id: 'job_embed', kind: 'embed', retry: true, maxAttempts: 3 });
}

async function handleModelEnrich(repo: Repo, job: Job): Promise<Record<string, unknown>> {
  const item = await repo.getItem(job.itemId ?? '');
  if (!item || item.deleted) throw new JobError('ITEM_NOT_FOUND', 'Item was deleted.', false);
  const { provider, reason } = await loadProvider();
  if (!provider) throw new JobError('NO_PROVIDER', reason ?? 'No AI provider configured.', false);
  const { body, timed } = await sourceText(repo, item);
  try {
    const res = await provider.chat([{ role: 'user', content: enrichmentPrompt(item.title, item.url, item.note, body) }], { maxTokens: 900 });
    await repo.addUsage({ provider: provider.label, model: res.model, kind: 'enrich', promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens });
    const parsed = parseModelEnrichment(res.content);
    if (!parsed) throw new JobError('BAD_MODEL_OUTPUT', 'The model did not return valid JSON.', true);
    const now = new Date().toISOString();
    const local = item.enrichment ?? localEnrich({ title: item.title, note: item.note, bodyText: body, timedSegments: timed, now });
    const merged = mergeModelEnrichment(local, parsed, provider.label, now);
    await repo.updateItem(item.id, { enrichment: merged, ...(item.summaryOrigin !== 'user' ? { summary: merged.summary, summaryOrigin: 'model' as const } : {}) });
    emit('items');
    return { provider: provider.label };
  } catch (e) {
    if (e instanceof JobError) throw e;
    if (e instanceof ProviderError) throw new JobError(e.code, e.message, e.retryable);
    throw new JobError('PROVIDER_FAILED', String((e as Error).message ?? e), true);
  }
}

async function handleEmbed(repo: Repo): Promise<Record<string, unknown>> {
  const s = await getSettings();
  const { provider, reason } = await loadProvider();
  if (!provider?.embed || !s.ai.embeddingModel) throw new JobError('NO_PROVIDER', reason ?? 'No embedding model configured.', false);
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const batch = await repo.chunksMissingEmbeddings(s.ai.embeddingModel, 16);
    if (!batch.length) break;
    try {
      const vectors = await provider.embed(batch.map((b) => b.text));
      await repo.saveEmbeddings(s.ai.embeddingModel, batch.map((b, j) => ({ chunkId: b.id, vector: vectors[j] })));
      total += batch.length;
    } catch (e) {
      if (e instanceof ProviderError) throw new JobError(e.code, e.message, e.retryable);
      throw e;
    }
  }
  return { embedded: total };
}

async function requireClient() {
  const client = await getClient();
  if (!client) throw new JobError('NOT_PAIRED', 'Not connected to a server.', false);
  return client;
}

/** Server-side processing: sync the item up, start the job, then poll until it finishes. */
async function handleServerJob(repo: Repo, job: Job, kind: 'metadata' | 'captions' | 'transcribe' | 'enrich'): Promise<Record<string, unknown> | 'pending'> {
  const client = await requireClient();
  const itemId = job.itemId ?? '';
  const item = await repo.getItem(itemId);
  if (!item || item.deleted) throw new JobError('ITEM_NOT_FOUND', 'Item was deleted.', false);
  try {
    if (!job.serverJobId) {
      await runSync(repo, client); // the server needs the item before it can process it
      if (kind === 'transcribe') {
        const media = (await repo.listMedia(itemId))[0];
        if (!media) throw new JobError('NO_MEDIA', 'Attach an audio or video file first.', false);
        if (!media.uploadedAt) {
          const form = new FormData();
          form.append('file', { uri: media.uri, name: media.name, type: media.mime } as unknown as Blob);
          await client.uploadMedia(itemId, form);
          await repo.markMediaUploaded(media.id);
        }
        if (item.status !== 'TRANSCRIBING') await moveTo(repo, item, 'TRANSCRIBING');
      }
      const started = await client.process(itemId, kind, job.id);
      await repo.setServerJobId(job.id, started.job.id);
      return 'pending';
    }
    const { job: sj } = await client.job(job.serverJobId);
    if (sj.status === 'queued' || sj.status === 'running') return 'pending';
    if (sj.status !== 'succeeded') {
      if (kind === 'transcribe') await moveTo(repo, (await repo.getItem(itemId))!, 'NEEDS_INPUT', { code: sj.error_code ?? 'SERVER_FAILED', message: sj.error_message ?? 'Server processing failed.' });
      throw new JobError(sj.error_code ?? 'SERVER_FAILED', sj.error_message ?? 'Server processing failed.', sj.status === 'failed_retryable');
    }
    if (kind === 'captions' || kind === 'transcribe') {
      const { transcripts } = await client.transcripts(itemId);
      for (const t of transcripts) {
        await repo.upsertTranscript({
          itemId, language: t.language, languageMethod: t.language === 'und' ? 'heuristic' : 'provider', kind: t.kind, source: `server_${t.source}`.slice(0, 40),
          provider: t.provider, format: null, origin: 'server',
          segments: t.segments.length ? t.segments.map((s) => ({ startMs: s.start_ms, endMs: s.end_ms, text: s.text })) : [{ startMs: null, endMs: null, text: t.text }],
        });
      }
      await schedulePipeline(itemId);
    } else {
      await runSync(repo, client); // pull the server's updated item (metadata/enrichment)
    }
    emit('items');
    return { serverJob: sj.id };
  } catch (e) {
    if (e instanceof JobError) throw e;
    if (e instanceof ApiError) throw new JobError(e.code ?? e.kind.toUpperCase(), e.message, e.retryable);
    throw e;
  }
}

async function handleSync(repo: Repo): Promise<Record<string, unknown>> {
  const client = await getClient();
  if (!client || !(await repo.syncEnabled())) return { skipped: true };
  try {
    const stats = await runSync(repo, client);
    emit('items', 'collections', 'conflicts', 'connection');
    return { ...stats };
  } catch (e) {
    if (e instanceof ApiError) throw new JobError(e.kind.toUpperCase(), e.message, e.retryable);
    throw e;
  }
}

async function handleScheduledReport(): Promise<Record<string, unknown>> {
  const s = await getSettings();
  if (!s.scheduledDailyReport) return { skipped: true };
  const r = await generateReport({ kind: 'yesterday' });
  return { reportId: r.id };
}

let running = false;

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
          let result: Record<string, unknown> | 'pending';
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
              result = await handleServerJob(repo, job, 'metadata');
              break;
            case 'server_captions':
              result = await handleServerJob(repo, job, 'captions');
              break;
            case 'server_transcribe':
              result = await handleServerJob(repo, job, 'transcribe');
              break;
            case 'server_enrich':
              result = await handleServerJob(repo, job, 'enrich');
              break;
            case 'sync':
              result = await handleSync(repo);
              break;
            case 'scheduled_report':
              result = await handleScheduledReport();
              break;
            default:
              throw new JobError('UNKNOWN_JOB', `Unknown job ${job.kind}`, false);
          }
          if (result === 'pending') {
            // Poll the server job again shortly without consuming an attempt.
            await repo.db.run(`UPDATE jobs SET status = 'queued', attempts = attempts - 1, run_after = ? WHERE id = ?`, [new Date(Date.now() + 15_000).toISOString(), job.id]);
          } else await repo.completeJob(job.id, result);
        } catch (e) {
          const err = e instanceof JobError ? e : new JobError('INTERNAL', (e as Error)?.message ?? 'Unexpected error', true);
          const updated = await repo.failJob(job.id, { code: err.code, message: err.message, retryable: err.retryable });
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
  }
  return done;
}

/** Ask for server-side processing — always a deliberate user action (it uploads data). */
export async function requestServerProcessing(itemId: string, kind: 'metadata' | 'captions' | 'transcribe' | 'enrich'): Promise<void> {
  if (!(await getConnection())) throw new Error('Connect to your server first (Settings → Connect to My Server).');
  const repo = await getRepo();
  await repo.enqueueJob({ id: `job_server_${kind}_${itemId}`, kind: `server_${kind}` as Job['kind'], itemId, retry: true, maxAttempts: 4 });
  emit('jobs');
  void runDueJobs();
}

export async function requestModelEnrichment(itemId: string): Promise<void> {
  const repo = await getRepo();
  await repo.enqueueJob({ id: `job_model_enrich_${itemId}`, kind: 'model_enrich', itemId, retry: true, maxAttempts: 3 });
  emit('jobs');
  void runDueJobs();
}

export async function requestSync(): Promise<void> {
  const repo = await getRepo();
  await repo.enqueueJob({ id: 'job_sync', kind: 'sync', retry: true, maxAttempts: 6 });
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
