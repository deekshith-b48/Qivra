/**
 * Item processing state machine:
 *   CAPTURED → METADATA_CHECK → NEEDS_INPUT | TRANSCRIBING → ENRICHING → INDEXING → READY
 * plus FAILED_RETRYABLE, FAILED_PERMANENT and CANCELLED.
 * Every transition the app performs goes through `transition()`, so an item
 * can never jump to READY without passing through indexing.
 */

export type ItemStatus =
  | 'CAPTURED'
  | 'METADATA_CHECK'
  | 'NEEDS_INPUT'
  | 'TRANSCRIBING'
  | 'ENRICHING'
  | 'INDEXING'
  | 'READY'
  | 'FAILED_RETRYABLE'
  | 'FAILED_PERMANENT'
  | 'CANCELLED';

export const ALL_STATUSES: ItemStatus[] = [
  'CAPTURED', 'METADATA_CHECK', 'NEEDS_INPUT', 'TRANSCRIBING', 'ENRICHING', 'INDEXING', 'READY',
  'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'CANCELLED',
];

const FAIL: ItemStatus[] = ['FAILED_RETRYABLE', 'FAILED_PERMANENT', 'CANCELLED'];

const ALLOWED: Record<ItemStatus, ItemStatus[]> = {
  CAPTURED: ['METADATA_CHECK', 'ENRICHING', 'INDEXING', ...FAIL],
  METADATA_CHECK: ['NEEDS_INPUT', 'TRANSCRIBING', 'ENRICHING', 'INDEXING', ...FAIL],
  NEEDS_INPUT: ['TRANSCRIBING', 'ENRICHING', 'INDEXING', 'METADATA_CHECK', 'CANCELLED'],
  TRANSCRIBING: ['ENRICHING', 'INDEXING', 'NEEDS_INPUT', ...FAIL],
  ENRICHING: ['INDEXING', ...FAIL],
  INDEXING: ['READY', ...FAIL],
  // A ready item can be reprocessed (new transcript, correction, retry enrichment).
  READY: ['METADATA_CHECK', 'TRANSCRIBING', 'ENRICHING', 'INDEXING'],
  FAILED_RETRYABLE: ['METADATA_CHECK', 'TRANSCRIBING', 'ENRICHING', 'INDEXING', 'FAILED_PERMANENT', 'CANCELLED'],
  FAILED_PERMANENT: ['METADATA_CHECK', 'ENRICHING', 'INDEXING', 'NEEDS_INPUT'],
  CANCELLED: ['METADATA_CHECK', 'ENRICHING', 'INDEXING'],
};

export class InvalidTransitionError extends Error {
  constructor(public from: ItemStatus, public to: ItemStatus) {
    super(`Invalid status transition ${from} → ${to}`);
  }
}

export function canTransition(from: ItemStatus, to: ItemStatus): boolean {
  return from === to || ALLOWED[from].includes(to);
}

export function transition(from: ItemStatus, to: ItemStatus): ItemStatus {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

export function isFailed(s: ItemStatus): boolean {
  return s === 'FAILED_RETRYABLE' || s === 'FAILED_PERMANENT';
}

export function isPending(s: ItemStatus): boolean {
  return ['CAPTURED', 'METADATA_CHECK', 'TRANSCRIBING', 'ENRICHING', 'INDEXING'].includes(s);
}

export const STATUS_LABELS: Record<ItemStatus, string> = {
  CAPTURED: 'Captured',
  METADATA_CHECK: 'Checking metadata',
  NEEDS_INPUT: 'Needs transcript',
  TRANSCRIBING: 'Transcribing',
  ENRICHING: 'Extracting knowledge',
  INDEXING: 'Indexing',
  READY: 'Ready',
  FAILED_RETRYABLE: 'Failed — will retry',
  FAILED_PERMANENT: 'Failed',
  CANCELLED: 'Cancelled',
};

/** Exponential backoff with full jitter, capped (ms). */
export function backoffMs(attempt: number, baseMs = 15_000, capMs = 6 * 3600_000, rand: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + rand() * (exp / 2));
}
