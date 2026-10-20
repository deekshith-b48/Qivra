/** Report generation (local data) and export via the Storage Access Framework. */

import * as FS from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { neutralise, SYSTEM_RULES } from '../core/agent/guard';
import { validateCitations } from '../core/agent/citations';
import { rangeFor, type DateRange } from '../core/dates';
import { newId } from '../core/ids';
import { buildReport, markdownToPlainText, type ReportKind, type ReportSource } from '../core/reports';
import type { Report } from '../db/types';
import { loadProvider } from './ai';
import { getRepo } from './db';
import { emit } from './events';
import { getSettings } from './settings';

export interface ReportRequest {
  kind: ReportKind;
  topic?: string;
  itemIds?: string[];
  custom?: { from: string; to: string };
  useAi?: boolean;
}

export async function generateReport(req: ReportRequest): Promise<Report> {
  const repo = await getRepo();
  const s = await getSettings();
  const now = Date.now();
  let range: DateRange;
  if (req.kind === 'yesterday') range = rangeFor('yesterday', now, s.timezone);
  else if (req.kind === 'weekly') range = rangeFor('week', now, s.timezone);
  else if (req.kind === 'daily') range = rangeFor('today', now, s.timezone);
  else if (req.custom) range = rangeFor('custom', now, s.timezone, req.custom);
  else range = rangeFor('last30', now, s.timezone);

  let items = req.kind === 'selection' && req.itemIds?.length ? await repo.itemsByIds(req.itemIds) : await repo.itemsInRange(range.startIso, range.endIso, 300);
  if ((req.kind === 'topic' || req.kind === 'developer') && req.topic?.trim()) {
    const hits = await repo.searchChunks(req.topic, { itemIds: items.map((i) => i.id), limit: 500 });
    const ids = new Set(hits.map((h) => h.itemId));
    items = items.filter((i) => ids.has(i.id));
  }
  if (req.kind === 'developer') items = items.filter((i) => (i.enrichment?.tools.length ?? 0) + (i.enrichment?.repos.length ?? 0) + (i.enrichment?.commands.length ?? 0) > 0 || i.sourceType === 'github');

  const sources: ReportSource[] = [];
  for (const it of items) {
    const transcripts = await repo.listTranscripts(it.id);
    const highlights: { startMs: number | null; text: string }[] = [];
    const ts = it.enrichment?.timestamps ?? [];
    if (ts.length) highlights.push(...ts.map((t) => ({ startMs: t.ms, text: t.label })));
    else if (transcripts[0]?.hasTimestamps) highlights.push(...(await repo.getSegments(transcripts[0].id)).filter((x) => x.startMs !== null).slice(0, 3));
    sources.push({
      id: it.id, title: it.title, url: it.url, sourceType: it.sourceType, capturedAt: it.capturedAt, summary: it.summary, summaryOrigin: it.summaryOrigin,
      note: it.note, tags: it.tags, language: it.language, enrichment: it.enrichment, hasTranscript: transcripts.length > 0,
      transcriptLanguages: transcripts.map((t) => `${t.language}${t.kind === 'translation' ? ' (translation)' : ''}`), highlights,
    });
  }

  let ai: { executiveSummary: string; provider: string; model: string | null } | null = null;
  let aiUnavailableReason: string | null = null;
  if (req.useAi && sources.length) {
    const { provider, reason } = await loadProvider();
    if (!provider) aiUnavailableReason = reason;
    else {
      try {
        const prompt = `${SYSTEM_RULES}\n\nWrite a 3-6 sentence executive summary of what the user saved, citing sources as [S#].\n\nSOURCES:\n${sources
          .slice(0, 25)
          .map((src, i) => `<source id="S${i + 1}">${neutralise(src.title, 200)} — ${neutralise(src.summary || src.note, 700)}</source>`)
          .join('\n')}`;
        const res = await provider.chat([{ role: 'user', content: prompt }], { maxTokens: 500 });
        await repo.addUsage({ provider: provider.label, model: res.model, kind: 'report', ...res.usage });
        const check = validateCitations(res.content, sources.slice(0, 25).map((_x, i) => `S${i + 1}`));
        ai = { executiveSummary: check.text, provider: provider.label, model: res.model };
      } catch (e) {
        aiUnavailableReason = `AI summary failed: ${(e as Error).message}`;
      }
    }
  }

  const built = buildReport({ kind: req.kind, range, generatedAt: new Date().toISOString(), topic: req.topic, sources, ai, aiUnavailableReason });
  const report = await repo.saveReport({
    id: newId('rep'), title: built.title, kind: req.kind, rangeStart: range.startIso, rangeEnd: range.endIso, timezone: s.timezone,
    params: { ...req }, markdown: built.markdown, provider: ai?.provider ?? null, itemIds: items.map((i) => i.id), filename: built.filename, createdAt: new Date().toISOString(),
  });
  emit('reports');
  return report;
}

export async function regenerateReport(report: Report): Promise<Report> {
  const params = report.params as unknown as ReportRequest;
  return generateReport({ ...params, kind: (params.kind ?? report.kind) as ReportKind });
}

/**
 * Export through Android's Storage Access Framework: the user picks a folder,
 * we create the file there, then read it back to confirm it really exists
 * before reporting success.
 */
export async function exportReport(report: Report, format: 'md' | 'txt'): Promise<{ uri: string } | { cancelled: true }> {
  const SAF = FS.StorageAccessFramework;
  const perm = await SAF.requestDirectoryPermissionsAsync();
  if (!perm.granted) return { cancelled: true };
  const body = format === 'md' ? report.markdown : markdownToPlainText(report.markdown);
  const name = format === 'md' ? report.filename : report.filename.replace(/\.md$/, '.txt');
  // Pass the full name: providers keep an extension that already matches the MIME type.
  const uri = await SAF.createFileAsync(perm.directoryUri, name, format === 'md' ? 'text/markdown' : 'text/plain');
  await SAF.writeAsStringAsync(uri, body);
  const check = await SAF.readAsStringAsync(uri);
  if (check.length !== body.length) throw new Error('The exported file could not be verified.');
  const repo = await getRepo();
  await repo.markReportExported(report.id, uri);
  emit('reports');
  return { uri };
}

/** Share sheet (user chooses the target app). Writes a temporary copy in the cache directory. */
export async function shareReport(report: Report): Promise<void> {
  const path = `${FS.cacheDirectory}${report.filename}`;
  await FS.writeAsStringAsync(path, report.markdown);
  await Sharing.shareAsync(path, { mimeType: 'text/markdown', dialogTitle: report.title });
}

export async function exportLibrary(): Promise<{ uri: string } | { cancelled: true }> {
  const repo = await getRepo();
  const SAF = FS.StorageAccessFramework;
  const perm = await SAF.requestDirectoryPermissionsAsync();
  if (!perm.granted) return { cancelled: true };
  const body = JSON.stringify(await repo.exportAll(), null, 2);
  const uri = await SAF.createFileAsync(perm.directoryUri, `Qivra-Library-Export-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  await SAF.writeAsStringAsync(uri, body);
  const check = await SAF.readAsStringAsync(uri);
  if (check.length !== body.length) throw new Error('The export could not be verified.');
  return { uri };
}
