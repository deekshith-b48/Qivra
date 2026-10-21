import type { Enrichment } from '../core/enrich';
import type { SmartRules } from '../core/smart';
import type { ItemStatus } from '../core/status';
import type { Segment } from '../core/transcripts';
import type { SourceType } from '../core/url';

export type SyncStatus = 'local_only' | 'pending' | 'synced' | 'conflicted' | 'failed';
/** Where a piece of content came from — shown as a provenance badge in the UI. */
export type Origin = 'none' | 'local' | 'user' | 'model' | 'server';

export interface ItemMetadata {
  title?: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  author?: string;
  fetchedAt?: string;
  provider?: string;
}

export interface Item {
  id: string;
  sourceType: SourceType;
  url: string | null;
  dedupeKey: string | null;
  title: string;
  note: string;
  author: string;
  siteName: string;
  thumbnailUrl: string;
  summary: string;
  summaryOrigin: Origin;
  language: string;
  languageMethod: 'heuristic' | 'provider' | 'user';
  status: ItemStatus;
  errorCode: string | null;
  errorMessage: string | null;
  enrichment: Enrichment | null;
  metadata: ItemMetadata | null;
  origin: 'local' | 'share' | 'server' | 'superbrain';
  capturedAt: string;
  createdAt: string;
  updatedAt: string;
  lastViewedAt: string | null;
  archived: boolean;
  deleted: boolean;
  localRev: number;
  syncedLocalRev: number;
  serverRevision: number | null;
  syncStatus: SyncStatus;
  tags: string[];
}

export interface NewItem {
  id?: string;
  sourceType: SourceType;
  url?: string | null;
  dedupeKey?: string | null;
  title?: string;
  note?: string;
  author?: string;
  summary?: string;
  status?: ItemStatus;
  origin?: Item['origin'];
  capturedAt?: string;
  tags?: string[];
}

export interface Collection {
  id: string;
  name: string;
  icon: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  syncStatus: SyncStatus;
  /** Set for a smart collection: its items are whatever matches these rules. */
  rules: SmartRules | null;
}

export interface CollectionSuggestion {
  /** Lowercase concept or tag, used as the collection name. */
  name: string;
  kind: 'concept' | 'tag';
  count: number;
  rules: SmartRules;
}

/** A local-only flashcard with its spaced-repetition state. */
export interface Card {
  id: string;
  itemId: string;
  front: string;
  back: string;
  /** Transcript moment the answer comes from, when known. */
  startMs: number | null;
  dueAt: string;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  createdAt: string;
  origin: 'model' | 'local';
}

export interface Transcript {
  id: string;
  itemId: string;
  language: string;
  languageMethod: 'heuristic' | 'provider' | 'user';
  kind: 'original' | 'translation';
  source: string;
  provider: string | null;
  format: string | null;
  text: string;
  segmentCount: number;
  hasTimestamps: boolean;
  origin: 'local' | 'server';
  corrected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptInput {
  itemId: string;
  language: string;
  languageMethod?: Transcript['languageMethod'];
  kind?: Transcript['kind'];
  source: string;
  provider?: string | null;
  format?: string | null;
  segments: Segment[];
  origin?: Transcript['origin'];
}

export type JobKind =
  | 'local_enrich'
  | 'index'
  | 'server_metadata'
  | 'server_captions'
  | 'server_transcribe'
  | 'server_transcribe_url'
  | 'server_enrich'
  | 'model_enrich'
  | 'embed'
  | 'sync'
  | 'scheduled_report';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed_retryable' | 'failed_permanent' | 'cancelled';

export interface Job {
  id: string;
  itemId: string | null;
  kind: JobKind;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lastErrorCode: string | null;
  lastError: string | null;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  serverJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChunkHit {
  chunkId: number;
  itemId: string;
  transcriptId: string | null;
  kind: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
  language: string | null;
  rank: number;
}

export interface Report {
  id: string;
  title: string;
  kind: string;
  rangeStart: string;
  rangeEnd: string;
  timezone: string;
  params: Record<string, unknown>;
  markdown: string;
  provider: string | null;
  itemIds: string[];
  filename: string;
  exportedUri: string | null;
  exportedAt: string | null;
  createdAt: string;
}

export interface Citation {
  sid: string;
  itemId: string;
  transcriptId: string | null;
  chunkId: number | null;
  startMs: number | null;
  quote: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  mode: string | null;
  provider: string | null;
  warnings: string[];
  proposals: unknown[];
  citations: Citation[];
  createdAt: string;
}

export interface Conflict {
  id: string;
  entityKind: 'item' | 'collection';
  entityId: string;
  remote: Record<string, unknown>;
  remoteRevision: number;
  detectedAt: string;
}
