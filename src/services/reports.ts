/** Report generation (local data), export via the Storage Access Framework, and PDF sharing. */

import * as FS from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { neutralise, SYSTEM_RULES } from '../core/agent/guard';
import { validateCitations } from '../core/agent/citations';
import { newId } from '../core/ids';
import { selectReportItems, toReportSources, type ReportRequest } from '../core/reportData';
import { reportToHtml } from '../core/reportHtml';
import { buildReport, markdownToPlainText, type ReportKind } from '../core/reports';
import type { Report } from '../db/types';
import { loadProvider } from './ai';
import { getRepo } from './db';
import { emit } from './events';
import { getSettings } from './settings';

export type { ReportRequest };

export async function generateReport(req: ReportRequest): Promise<Report> {
  const repo = await getRepo();
  const s = await getSettings();
  const { range, items, collection } = await selectReportItems(repo, req, Date.now(), s.timezone);
  const sources = await toReportSources(repo, items);

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

  const built = buildReport({ kind: req.kind, range, generatedAt: new Date().toISOString(), topic: req.topic, collection, sources, ai, aiUnavailableReason });
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

/**
 * PDF: the report Markdown is rendered to escaped, self-contained HTML, printed
 * to a temporary file by the system WebView, then handed to the share sheet
 * (save to Files/Drive, print, send). Nothing is uploaded by Qivra itself.
 */
export async function shareReportPdf(report: Report): Promise<void> {
  const { uri } = await Print.printToFileAsync({ html: reportToHtml(report.markdown, report.title) });
  const name = report.filename.replace(/\.md$/, '.pdf');
  const target = `${FS.cacheDirectory}${name}`;
  await FS.deleteAsync(target, { idempotent: true });
  await FS.moveAsync({ from: uri, to: target });
  await Sharing.shareAsync(target, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: report.title });
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
