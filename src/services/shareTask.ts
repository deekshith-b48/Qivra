/**
 * Headless share processing: Android's ShareActivity saves the share, shows a
 * toast and starts QivraShareTaskService, so the user stays in Instagram/X/
 * YouTube. This task ingests the share, runs the pipeline until each item is
 * settled (transcript, summary, AI summary) or the time budget runs out, and
 * hands the service one "Ready" notification per item (see notify.ts). Anything unfinished keeps
 * going in the background job runner or the next time the app opens.
 */

import { isFailed } from '../core/status';
import type { Repo } from '../db/repo';
import type { Item } from '../db/types';
import { drainShareInbox } from './capture';
import { getRepo } from './db';
import { type ReadyNote, readyNote, writeShareResult } from './notify';
import { recoverIfIdle, runDueJobs, wakeWaitingJobs } from './processing';

export const SHARE_TASK_NAME = 'QivraShare';
const BUDGET_MS = 150_000; // the native service allows 170 s
const POLL_MS = 2_500;

const ACTIVE_JOB = new Set(['queued', 'running', 'failed_retryable']);

/** Done enough to notify: finished (incl. its AI summary), or needs the user. */
export async function isSettled(repo: Repo, item: Item | null): Promise<boolean> {
  if (!item || item.deleted || item.status === 'CANCELLED' || item.status === 'NEEDS_INPUT' || isFailed(item.status)) return true;
  if (item.status !== 'READY') return false;
  const ai = await repo.getJob(`job_model_enrich_${item.id}`);
  return !ai || !ACTIVE_JOB.has(ai.status);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runShareTask(opts: { budgetMs?: number; pollMs?: number } = {}): Promise<{ itemIds: string[]; settled: boolean }> {
  const notes: ReadyNote[] = [];
  let itemIds: string[] = [];
  let settled = true;
  try {
    const budget = opts.budgetMs ?? BUDGET_MS;
    const poll = opts.pollMs ?? POLL_MS;
    const deadline = Date.now() + budget;
    const repo = await getRepo();
    // Android may have killed Qivra mid-job; the app is not open to recover it, so do it here.
    await recoverIfIdle().catch(() => 0);
    const shared = await drainShareInbox();
    // Duplicates are notified too: the user shared it again and expects to land on it.
    itemIds = [...new Set(shared.results.filter((r) => r.itemId && !r.error).map((r) => r.itemId as string))];
    if (!itemIds.length) return { itemIds, settled };
    // Earlier shares that were waiting for the internet can go now too.
    await wakeWaitingJobs(repo);
    while (true) {
      await runDueJobs(Math.max(1_000, Math.min(20_000, deadline - Date.now())));
      const items = await Promise.all(itemIds.map((id) => repo.getItem(id)));
      settled = (await Promise.all(items.map((i) => isSettled(repo, i)))).every(Boolean);
      if (settled || Date.now() + poll >= deadline) break;
      await sleep(poll);
    }
    for (const id of itemIds) {
      const item = await repo.getItem(id);
      if (item && !item.deleted) notes.push(readyNote(item));
    }
    return { itemIds, settled };
  } finally {
    // Always answer the native service: it posts the notes and stops itself.
    await writeShareResult(notes).catch(() => undefined);
  }
}
