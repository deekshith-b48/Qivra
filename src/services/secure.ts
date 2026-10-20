/**
 * Secrets in Android Keystore-backed storage (expo-secure-store).
 * Only the paired-device credential and the user's optional AI API key are
 * stored here. They are never logged, synced, exported or put on the clipboard.
 */

import * as SecureStore from 'expo-secure-store';

const OPTS: SecureStore.SecureStoreOptions = { keychainService: 'qivra' };

export const SECRET_KEYS = {
  deviceToken: 'qivra.device_token',
  aiApiKey: 'qivra.ai_api_key',
} as const;

export async function getSecret(key: (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS]): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key, OPTS);
  } catch {
    // Keystore can be invalidated (e.g. lock-screen removal). Treat as missing; the user re-pairs.
    return null;
  }
}

export async function setSecret(key: (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS], value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, OPTS);
}

export async function deleteSecret(key: (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS]): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key, OPTS);
  } catch {
    /* already gone */
  }
}
