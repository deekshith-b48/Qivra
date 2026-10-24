/**
 * "Your saved item is ready" notifications for shares processed in the background.
 *
 * The headless share task (shareTask.ts) writes its result to
 * files/share_task/result-<id>.json. Native QivraShareTaskService picks it up,
 * posts one notification per item whose tap opens qivra://item/<id>, and then
 * stops itself. (Posting natively keeps taps working when the app was started
 * headless, and doubles as the "task finished" signal the service needs.)
 * Without notification permission nothing is shown; the item is still saved.
 */

import * as FS from 'expo-file-system/legacy';
import { isFailed } from '../core/status';
import type { Item } from '../db/types';

export const SHARE_TASK_DIR = () => `${FS.documentDirectory}share_task/`;

export interface ReadyNote {
  itemId: string;
  title: string;
  body: string;
}

function firstSentence(text: string, max = 140): string {
  const s = text.replace(/\s+/g, ' ').trim();
  const cut = s.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? s;
  return cut.length > max ? `${cut.slice(0, max - 1).trimEnd()}…` : cut;
}

/** Title and body for an item's notification; pure so it can be unit-tested. */
export function readyMessage(item: Pick<Item, 'title' | 'url' | 'summary' | 'status' | 'errorCode' | 'errorMessage'>): { title: string; body: string } {
  const name = (item.title || item.url || 'Saved item').slice(0, 80);
  if (item.status === 'NEEDS_INPUT') {
    return { title: `Needs a transcript: ${name}`, body: item.errorMessage ? firstSentence(item.errorMessage) : 'Open it to add a transcript.' };
  }
  if (isFailed(item.status)) return { title: `Could not finish: ${name}`, body: 'Open it to retry.' };
  if (item.status === 'TRANSCRIBING') return { title: `Saved: ${name}`, body: 'Still transcribing — it will be ready in the app.' };
  return { title: `Ready: ${name}`, body: item.summary ? firstSentence(item.summary) : 'Saved to your library.' };
}

export function readyNote(item: Item): ReadyNote {
  return { itemId: item.id, ...readyMessage(item) };
}

/** Hand the result to the native service (always called, even with no notes, so it can stop). */
export async function writeShareResult(notes: ReadyNote[]): Promise<void> {
  const dir = SHARE_TASK_DIR();
  await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
  const name = `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Written under a temporary name, then renamed, so the service never reads half a file.
  await FS.writeAsStringAsync(`${dir}${name}.tmp`, JSON.stringify({ version: 1, notes }));
  await FS.moveAsync({ from: `${dir}${name}.tmp`, to: `${dir}${name}.json` });
}
