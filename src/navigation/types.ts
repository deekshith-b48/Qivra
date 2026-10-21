import type { NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CaptureResult } from '../services/capture';

export type TabParamList = {
  Today: undefined;
  Library: { collectionId?: string; q?: string } | undefined;
  /** Placeholder route for the centre "+" button; it opens the capture sheet. */
  Save: undefined;
  /** `itemId` scopes the conversation to one saved item ("Ask this item"). */
  Agent: { conversationId?: string; prompt?: string; itemId?: string } | undefined;
};

export type RootStackParamList = {
  Onboarding: undefined;
  Main: NavigatorScreenParams<TabParamList> | undefined;
  /** `at` (ms) seeks the embedded player / scrolls the transcript to that moment. */
  ItemDetail: { id: string; at?: number };
  Capture: { mode?: 'link' | 'note' | 'voice' | 'transcript' | 'media' } | undefined;
  TranscriptImport: { itemId: string; kind?: 'original' | 'translation' };
  ShareReceipt: { results: CaptureResult[]; rejected: { name: string; reason: string }[] };
  Collections: undefined;
  Reports: undefined;
  ReportDetail: { id: string };
  Settings: undefined;
  ConnectServer: { scanned?: string } | undefined;
  QrScan: undefined;
  AiProviders: undefined;
  VoiceSettings: undefined;
  PrivacyStorage: undefined;
  Jobs: undefined;
  Conflicts: undefined;
  About: undefined;
};

export type RootProps<K extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, K>;
