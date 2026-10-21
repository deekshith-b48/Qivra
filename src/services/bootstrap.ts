/** App start-up: open + migrate the DB, recover jobs, import legacy data, drain the share inbox. */

import * as Crypto from 'expo-crypto';
import { setRandomSource } from '../core/ids';
import { registerBackgroundWork } from './background';
import { drainShareInbox, type CaptureResult } from './capture';
import { getRepo } from './db';
import { runLegacyImport } from './legacyImport';
import { requestSync, runDueJobs, wakeServerJobs } from './processing';
import { checkConnection, getConnection } from './server';

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
    if (await getConnection()) {
      const c = await checkConnection();
      if (c && !c.lastError) await wakeServerJobs(repo);
      if (await repo.syncEnabled()) await requestSync();
    }
    await runDueJobs();
  })();
  return { onboarded, legacyImported: legacy?.posts ?? 0, shared };
}

/** Called when the app returns to the foreground or receives a new share. */
export async function onResume(): Promise<BootResult['shared']> {
  const shared = await drainShareInbox().catch(() => ({ results: [], rejected: [] }));
  void (async () => {
    // Picks up a server that was (re)started meanwhile, including its AI gateway.
    if (await getConnection()) {
      const c = await checkConnection().catch(() => null);
      if (c && !c.lastError) await wakeServerJobs(await getRepo());
    }
    await runDueJobs();
  })();
  return shared;
}
