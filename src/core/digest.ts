/** Daily digest notification text (pure; used by services/reminders.ts). */

import type { Item } from '../db/types';

/** Digest text from the home feed; pure so it can be unit-tested. */
export function digestMessage(ready: Pick<Item, 'title' | 'url'>[], readyTotal: number, resurface: Pick<Item, 'title' | 'url'> | null): { title: string; body: string } {
  const name = (i: Pick<Item, 'title' | 'url'>) => (i.title || i.url || 'Saved item').slice(0, 60);
  if (readyTotal > 0) {
    const more = readyTotal > ready.length ? ` and ${readyTotal - ready.length} more` : '';
    return { title: `${readyTotal} ready to review`, body: `${ready.slice(0, 3).map(name).join(' · ')}${more}` };
  }
  if (resurface) return { title: 'From your library', body: `Revisit: ${name(resurface)}` };
  return { title: 'Qivra', body: 'Nothing new today. Share a reel, video or page to start.' };
}
