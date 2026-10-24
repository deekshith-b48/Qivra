/** App start-up: open + migrate the DB, recover jobs, import legacy data, drain the share inbox. */

import * as Crypto from 'expo-crypto';
import { setRandomSource } from '../core/ids';
import { registerBackgroundWork } from './background';
import { drainShareInbox, type CaptureResult } from './capture';
import { getRepo } from './db';
import { runLegacyImport } from './legacyImport';
import { removeServerOnce, runDueJobs, upgradeOldReadmes, wakeWaitingJobs } from './processing';
import { refreshDailyDigest } from './reminders';
import { ensureEmbeddings } from './semantic';
import { maybeGenerateWeeklyReport } from './weeklyReport';

setRandomSource((bytes) => Crypto.getRandomValues(bytes));

export interface BootResult {
  onboarded: boolean;
  legacyImported: number;
  shared: { results: CaptureResult[]; rejected: { name: string; reason: string }[] };
}

export async function boot(): Promise<BootResult> {
  const repo = await getRepo();
  await repo.recoverRunningJobs();
  const legacy = await runLegacyImport().catch(() => null);
  const shared = await drainShareInbox().catch(() => ({ results: [], rejected: [] }));
  const onboarded = (await repo.getMeta('app.onboarded')) === '1';
  void registerBackgroundWork();
  void (async () => {
    // Installs that were paired with the old laptop server move everything onto the phone (once).
    await removeServerOnce(repo).catch(() => 0);
    await runDueJobs();
    await refreshDailyDigest();
    // Backfill meaning-based search for anything not embedded yet (new items, or a newly available model).
    if (await ensureEmbeddings().catch(() => false)) await runDueJobs();
    await upgradeOldReadmes().catch(() => 0);
    await maybeGenerateWeeklyReport();
  })();
  return { onboarded, legacyImported: legacy?.posts ?? 0, shared };
}

/** Called when the app returns to the foreground or receives a new share. */
export async function onResume(): Promise<BootResult['shared']> {
  const shared = await drainShareInbox().catch(() => ({ results: [], rejected: [] }));
  void (async () => {
    // Back in the app, probably online again: jobs that were waiting for the internet run now.
    await wakeWaitingJobs(await getRepo());
    await runDueJobs();
    await refreshDailyDigest();
    // Backfill meaning-based search for anything not embedded yet (new items, or a newly available model).
    if (await ensureEmbeddings().catch(() => false)) await runDueJobs();
    await maybeGenerateWeeklyReport();
  })();
  return shared;
}
