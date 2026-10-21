/**
 * Periodic background work through expo-background-task, which schedules an
 * Android WorkManager job (minimum interval 15 min; the OS may delay it for
 * battery/Doze/network). The task drains the share inbox, runs due jobs and
 * syncs. Work is durable in SQLite, so a skipped run loses nothing.
 * `defineBackgroundTask()` must run at module load (index.ts).
 */

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { drainShareInbox } from './capture';
import { getRepo } from './db';
import { requestSync, runDueJobs } from './processing';

export const BACKGROUND_TASK = 'qivra-background-work';

export function defineBackgroundTask(): void {
  if (TaskManager.isTaskDefined(BACKGROUND_TASK)) return;
  TaskManager.defineTask(BACKGROUND_TASK, async () => {
    try {
      const repo = await getRepo();
      await repo.recoverRunningJobs();
      await drainShareInbox();
      if (await repo.syncEnabled()) await requestSync();
      await runDueJobs(20_000);
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function registerBackgroundWork(): Promise<'registered' | 'restricted' | 'error'> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return 'restricted';
    if (!(await TaskManager.isTaskRegisteredAsync(BACKGROUND_TASK))) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_TASK, { minimumInterval: 30 });
    }
    return 'registered';
  } catch {
    return 'error';
  }
}
