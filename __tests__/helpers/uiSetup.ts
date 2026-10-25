/* UI test setup: the app's repository runs on real SQLite (node:sqlite) in memory. */
import 'react-native-gesture-handler/jestSetup';
import type { Repo } from '../../src/db/repo';

let mockRepoPromise: Promise<Repo> | null = null;

export function resetTestRepo(): void {
  mockRepoPromise = null;
}

jest.mock('../../src/services/db', () => ({
  DB_NAME: 'qivra.db',
  getRepo: () => {
    if (!mockRepoPromise) {
      mockRepoPromise = (async () => {
        const { openNodeDriver } = require('./nodeDriver');
        const { migrate } = require('../../src/db/schema');
        const { Repo } = require('../../src/db/repo');
        const db = openNodeDriver();
        await migrate(db);
        return new Repo(db);
      })();
    }
    return mockRepoPromise;
  },
}));

jest.mock('expo-localization', () => ({ getCalendars: () => [{ timeZone: 'Asia/Kolkata' }] }));
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: async (k: string) => store.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});
jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn(async () => ({ canceled: true })) }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///data/files/', cacheDirectory: 'file:///data/cache/', getInfoAsync: async () => ({ exists: false }) }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    SafeAreaProvider: ({ children }: { children: unknown }) => children,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
// Processing would hit the network for metadata; UI tests exercise the screens only.
jest.mock('../../src/services/processing', () => ({
  schedulePipeline: jest.fn(async () => undefined),
  recoverIfIdle: jest.fn(async () => 0),
  runDueJobs: jest.fn(async () => 0),
  wakeWaitingJobs: jest.fn(async () => undefined),
  removeServerOnce: jest.fn(async () => 0),
  retryItemsNeedingKey: jest.fn(async () => 0),
  requestModelEnrichment: jest.fn(async () => undefined),
  cancelItemProcessing: jest.fn(async () => undefined),
}));

// Notifications: permission (onboarding, settings) and scheduling (revisit reminders).
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true })),
  setNotificationChannelAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async () => 'notif-1'),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  SchedulableTriggerInputTypes: { DATE: 'date', DAILY: 'daily' },
}));
