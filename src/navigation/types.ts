import type { NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CaptureResult } from '../services/capture';

export type TabParamList = {
  Today: undefined;
  Library: { collectionId?: string } | undefined;
  Search: undefined;
  Agent: { conversationId?: string; prompt?: string } | undefined;
  Reports: undefined;
};

export type RootStackParamList = {
  Onboarding: undefined;
  Main: NavigatorScreenParams<TabParamList> | undefined;
  ItemDetail: { id: string };
  Capture: { mode?: 'link' | 'note' | 'transcript' | 'media' } | undefined;
  TranscriptImport: { itemId: string; kind?: 'original' | 'translation' };
  ShareReceipt: { results: CaptureResult[]; rejected: { name: string; reason: string }[] };
  Collections: undefined;
  ReportDetail: { id: string };
  Settings: undefined;
  ConnectServer: { scanned?: string } | undefined;
  QrScan: undefined;
  AiProviders: undefined;
  PrivacyStorage: undefined;
  Jobs: undefined;
  Conflicts: undefined;
  About: undefined;
};

export type RootProps<K extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, K>;
