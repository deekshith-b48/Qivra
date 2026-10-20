/** Reads SuperBrain's on-device data (if any) and imports it once. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import * as FS from 'expo-file-system/legacy';
import { importLegacy, type LegacyCollection, type LegacyPost, type LegacyStats } from '../db/legacy';
import { getRepo } from './db';
import { emit } from './events';

export async function runLegacyImport(): Promise<LegacyStats | null> {
  const repo = await getRepo();
  if ((await repo.getMeta('app.legacyImported')) === '1') return null;
  let posts: LegacyPost[] = [];
  try {
    const dbFile = `${FS.documentDirectory?.replace(/files\/$/, '')}databases/superbrain_local.db`;
    const exists = (await FS.getInfoAsync(dbFile)).exists;
    if (exists) {
      const old = await SQLite.openDatabaseAsync('superbrain_local.db');
      posts = await old.getAllAsync<LegacyPost>('SELECT * FROM posts');
      await old.closeAsync();
    }
  } catch {
    posts = [];
  }
  if (!posts.length) {
    try {
      const cached = await AsyncStorage.getItem('@superbrain_posts_cache');
      if (cached) posts = JSON.parse(cached) as LegacyPost[];
    } catch {
      /* ignore corrupt cache */
    }
  }
  let collections: LegacyCollection[] = [];
  try {
    const raw = await AsyncStorage.getItem('@superbrain_collections');
    if (raw) collections = JSON.parse(raw) as LegacyCollection[];
  } catch {
    collections = [];
  }
  const stats = await importLegacy(repo, { posts, collections });
  if (stats.posts || stats.collections) emit('items', 'collections');
  return stats;
}
