/**
 * Typed client for the paired Qivra server (`/api/health`, `/api/v1/*`).
 *
 * - Explicit per-request timeouts (AbortController).
 * - Retries with backoff only for safe/idempotent requests (GET, and POSTs that
 *   carry an idempotency key such as sync and process).
 * - Errors are mapped to a small set of user-facing kinds.
 * - Never logs credentials, transcripts or request bodies.
 */

import { checkServerUrl } from './net';

export type ApiErrorKind =
  | 'offline'
  | 'timeout'
  | 'unauthorized'
  | 'revoked'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'wrong_server'
  | 'pairing'
  | 'invalid_request'
  | 'host_rejected'
  | 'server'
  | 'invalid_response'
  | 'insecure_url';

export class ApiError extends Error {
  constructor(public kind: ApiErrorKind, message: string, public status = 0, public code: string | null = null, public body: unknown = null) {
    super(message);
  }
  get retryable(): boolean {
    return ['offline', 'timeout', 'rate_limited', 'server'].includes(this.kind);
  }
}

export const API_ERROR_HELP: Record<ApiErrorKind, string> = {
  offline: 'Cannot reach the server. Check that the laptop is on, the server is running, and both devices are on the same network.',
  timeout: 'The server took too long to respond. It may be busy or unreachable on this network.',
  unauthorized: 'This device is not paired with the server.',
  revoked: 'This device was revoked on the server. Pair again to reconnect.',
  forbidden: 'The server refused this action.',
  not_found: 'Not found on the server.',
  conflict: 'This changed on another device. Review the conflict.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  wrong_server: 'This QR code belongs to a different Qivra server.',
  pairing: 'Pairing failed.',
  invalid_request: 'The server rejected the request.',
  host_rejected: 'The server rejected this address. Use the exact URL printed by the server.',
  server: 'The server hit an error. Try again shortly.',
  invalid_response: 'The address responded, but it is not a Qivra server (wrong port?).',
  insecure_url: 'Refusing an unencrypted connection to a public address.',
};

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string | FormData; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ClientOptions {
  baseUrl: string;
  token?: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Health {
  status: string;
  product: string;
  version: string;
  api_version: number;
  server_id: string;
  time: string;
  lan_enabled: boolean;
  capabilities: string[];
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked: boolean;
}

export interface ServerEntity {
  kind: 'item' | 'collection';
  id: string;
  revision: number;
  seq: number;
  deleted: boolean;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface SyncChange {
  kind: 'item' | 'collection';
  id: string;
  base_revision: number | null;
  deleted: boolean;
  data: Record<string, unknown>;
}

export interface SyncResponse {
  applied: { kind: string; id: string; revision: number | null; seq: number | null }[];
  conflicts: { kind: 'item' | 'collection'; id: string; server: ServerEntity | null }[];
  changes: ServerEntity[];
  cursor: number;
  has_more: boolean;
  server_time: string;
}

export interface ServerJob {
  id: string;
  item_id: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed_retryable' | 'failed_permanent' | 'cancelled';
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  result: Record<string, unknown> | null;
}

export interface ServerTranscript {
  id: string;
  item_id: string;
  language: string;
  kind: 'original' | 'translation';
  source: string;
  provider: string | null;
  text: string;
  segments: { start_ms: number | null; end_ms: number | null; text: string }[];
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The paired server's AI gateway (the provider key itself stays on the server). */
export interface AiGatewayInfo {
  enabled: boolean;
  upstream?: string;
  model?: string;
  embedding_model?: string | null;
  external?: boolean;
}

export class QivraClient {
  readonly baseUrl: string;
  private token: string | null;
  private fetchImpl: FetchLike;
  private timeoutMs: number;
  private retries: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: ClientOptions) {
    const check = checkServerUrl(opts.baseUrl);
    if (!check.ok) throw new ApiError(check.code === 'CLEARTEXT_PUBLIC_HOST' ? 'insecure_url' : 'invalid_request', check.message);
    this.baseUrl = `${check.url.protocol}//${check.url.host}`;
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.sleep = opts.sleep ?? sleepDefault;
  }

  private async request<T>(method: string, path: string, body?: unknown, opts: { idempotent?: boolean; timeoutMs?: number; auth?: boolean } = {}): Promise<T> {
    const safe = method === 'GET' || !!opts.idempotent;
    const attempts = safe ? this.retries + 1 : 1;
    let last: ApiError | null = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(Math.min(8000, 500 * 2 ** (i - 1)));
      try {
        return await this.once<T>(method, path, body, opts);
      } catch (e) {
        last = e instanceof ApiError ? e : new ApiError('offline', API_ERROR_HELP.offline);
        if (!last.retryable) throw last;
      }
    }
    throw last as ApiError;
  }

  private async once<T>(method: string, path: string, body: unknown, opts: { timeoutMs?: number; auth?: boolean }): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.auth !== false && this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload: string | FormData | undefined;
    if (body instanceof FormDataCtor()) payload = body as FormData;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? this.timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: payload, signal: ctl.signal });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === 'AbortError';
      throw new ApiError(aborted ? 'timeout' : 'offline', aborted ? API_ERROR_HELP.timeout : API_ERROR_HELP.offline);
    } finally {
      clearTimeout(timer);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      if (res.ok) throw new ApiError('invalid_response', API_ERROR_HELP.invalid_response, res.status);
    }
    if (res.ok) return json as T;
    throw mapError(res.status, json);
  }

  // ── endpoints ──────────────────────────────────────────────────────────
  async health(timeoutMs = 5000): Promise<Health> {
    const h = await this.request<Health>('GET', '/api/health', undefined, { timeoutMs, auth: false });
    if (!h || h.product !== 'Qivra' || typeof h.server_id !== 'string') throw new ApiError('invalid_response', API_ERROR_HELP.invalid_response);
    return h;
  }

  completePairing(pairingId: string, deviceName: string, serverId: string | null) {
    return this.request<{ device: DeviceInfo; device_token: string; server_id: string; server_time: string }>(
      'POST', '/api/v1/pairing/complete', { pairing_id: pairingId, device_name: deviceName, platform: 'android', server_id: serverId ?? undefined }, { auth: false },
    );
  }

  pairingStatus() {
    return this.request<{ paired: boolean; device: DeviceInfo; server: { id: string; version: string; lan_enabled: boolean }; server_time: string; ai: { available: boolean; providers: Record<string, boolean> }; ai_gateway?: AiGatewayInfo }>('GET', '/api/v1/pairing/status');
  }

  devices() {
    return this.request<{ devices: DeviceInfo[] }>('GET', '/api/v1/devices');
  }

  revokeDevice(deviceId: string) {
    return this.request<{ revoked: boolean }>('POST', `/api/v1/devices/${encodeURIComponent(deviceId)}/revoke`, {});
  }

  sync(cursor: number, changes: SyncChange[]) {
    return this.request<SyncResponse>('POST', '/api/v1/sync', { cursor, changes }, { idempotent: true, timeoutMs: 30_000 });
  }

  importTranscript(itemId: string, body: { text: string; format?: string; language: string; kind?: string; source?: string }) {
    return this.request<{ transcript: ServerTranscript; format: string }>('POST', `/api/v1/items/${encodeURIComponent(itemId)}/transcripts/import`, body, { idempotent: true, timeoutMs: 30_000 });
  }

  transcripts(itemId: string) {
    return this.request<{ transcripts: ServerTranscript[] }>('GET', `/api/v1/items/${encodeURIComponent(itemId)}/transcripts`);
  }

  process(itemId: string, kind: 'metadata' | 'captions' | 'transcribe' | 'transcribe_url' | 'enrich', idempotencyKey: string) {
    return this.request<{ job: ServerJob; created: boolean }>('POST', `/api/v1/items/${encodeURIComponent(itemId)}/process`, { kind, idempotency_key: idempotencyKey }, { idempotent: true });
  }

  job(jobId: string) {
    return this.request<{ job: ServerJob }>('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  item(itemId: string) {
    return this.request<{ item: ServerEntity }>('GET', `/api/v1/items/${encodeURIComponent(itemId)}`);
  }

  uploadMedia(itemId: string, form: FormData) {
    return this.request<{ media: { id: string; size_bytes: number } }>('POST', `/api/v1/items/${encodeURIComponent(itemId)}/media`, form, { timeoutMs: 10 * 60_000 });
  }

  agent(message: string, timezone: string) {
    return this.request<{ mode: string; answer: string | null; sources: unknown[]; warnings: string[]; provider: string | null }>('POST', '/api/v1/agent/messages', { message, timezone }, { timeoutMs: 120_000 });
  }
}

function FormDataCtor(): { new (): FormData } {
  return (globalThis as unknown as { FormData?: { new (): FormData } }).FormData ?? (class Never {} as unknown as { new (): FormData });
}

export function mapError(status: number, json: unknown): ApiError {
  const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
  const code = err?.code ?? null;
  const msg = err?.message ?? `HTTP ${status}`;
  if (status === 401) {
    return code === 'INVALID_CREDENTIAL' ? new ApiError('revoked', API_ERROR_HELP.revoked, status, code, json) : new ApiError(code?.startsWith('PAIRING') ? 'pairing' : 'unauthorized', msg, status, code, json);
  }
  if (status === 409 && code === 'WRONG_SERVER') return new ApiError('wrong_server', API_ERROR_HELP.wrong_server, status, code, json);
  if (status === 409) return new ApiError('conflict', msg, status, code, json);
  if (status === 410 || (status === 400 && code?.startsWith('PAIRING'))) return new ApiError('pairing', msg, status, code, json);
  if (status === 421) return new ApiError('host_rejected', API_ERROR_HELP.host_rejected, status, code, json);
  if (status === 429) return new ApiError('rate_limited', API_ERROR_HELP.rate_limited, status, code, json);
  if (status === 403) return new ApiError('forbidden', msg, status, code, json);
  if (status === 404) return new ApiError('not_found', msg, status, code, json);
  if (status >= 500) return new ApiError('server', API_ERROR_HELP.server, status, code, json);
  return new ApiError('invalid_request', msg, status, code, json);
}
