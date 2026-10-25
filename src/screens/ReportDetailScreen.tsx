import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Alert, View } from 'react-native';
import { formatLocal } from '../core/dates';
import { markdownToPlainText, parseGlance, sourceBlocks, splitReport } from '../core/reports';
import type { RootProps } from '../navigation/types';
import { getRepo } from '../services/db';
import { emit } from '../services/events';
import { exportReport, regenerateReport, shareReport, shareReportPdf } from '../services/reports';
import { Banner, Button, Card, Group, Header, IconButton, Loading, Row, Screen, Sheet, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { Markdown } from '../ui/Markdown';
import { StatTile } from '../ui/tiles';
import { space, useTheme } from '../ui/theme';

export default function ReportDetailScreen({ navigation, route }: RootProps<'ReportDetail'>) {
  const { c } = useTheme();
  const { busy, run } = useAction();
  const [more, setMore] = useState(false);
  const q = useQuery((repo) => repo.getReport(route.params.id), ['reports'], [route.params.id]);
  const r = q.data;
  if (q.loading && !r) return <Screen><Loading /></Screen>;
  if (!r) return <Screen><Header title="Report" onBack={() => navigation.goBack()} /><Banner tone="warning" title="Report not found" /></Screen>;

  const parts = splitReport(r.markdown);
  const glance = parseGlance(r.markdown);
  const doExport = (fmt: 'md' | 'txt') => run(async () => {
    const res = await exportReport(r, fmt);
    if ('cancelled' in res) return;
    Alert.alert('Exported', `Saved and verified as ${fmt === 'md' ? r.filename : r.filename.replace(/\.md$/, '.txt')} in the folder you chose.`);
  }, 'Export failed');
  // Close the sheet first so alerts and share dialogs are not hidden behind it.
  const fromSheet = (fn: () => unknown) => () => { setMore(false); void fn(); };

  return (
    <Screen>
      <Header
        title="Report"
        onBack={() => navigation.goBack()}
        actions={<IconButton icon="trash-outline" label="Delete report" color={c.danger} onPress={() => void run(async () => {
          if (!(await confirm('Delete report?', 'This removes it from report history on this phone.', 'Delete', true))) return;
          await (await getRepo()).deleteReport(r.id);
          emit('reports');
          navigation.goBack();
        })} />}
      />
      <Card>
        <T v="title">{parts.title || r.title}</T>
        {parts.preamble ? <View style={{ marginTop: space.xs }}><Markdown source={parts.preamble} /></View> : null}
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
          <StatTile icon="documents-outline" tint="blue" value={r.itemIds.length} label="Items" />
          <StatTile icon="play-circle-outline" tint="red" value={glance.videos} label="Videos" />
          <StatTile icon="text-outline" tint="green" value={glance.transcripts} label="Transcripts" />
        </View>
        <T v="caption" color="textFaint" style={{ marginTop: space.sm }}>{formatLocal(r.createdAt, r.timezone)}{r.exportedAt ? ` · last exported ${formatLocal(r.exportedAt, r.timezone)}` : ''}</T>
      </Card>
      <View style={{ flexDirection: 'row', gap: space.sm, marginVertical: space.md }}>
        <Button title="Share PDF" icon="document-outline" style={{ flex: 1 }} loading={busy} onPress={() => void run(() => shareReportPdf(r), 'PDF export failed')} />
        <Button kind="tonal" title="More" icon="ellipsis-horizontal" onPress={() => setMore(true)} />
      </View>
      <View style={{ gap: space.md }}>
        {parts.sections.map((s, k) => (
          <Card key={k}>
            <T v="subtitle" accessibilityRole="header" style={{ marginBottom: space.sm }}>{s.heading}</T>
            {s.heading === 'By source'
              ? sourceBlocks(s.body).map((b, i) => (
                <View key={i} style={i ? { borderTopWidth: 1, borderColor: c.border, marginTop: space.sm, paddingTop: space.sm } : undefined}><Markdown source={b} /></View>
              ))
              : <Markdown source={s.body} />}
          </Card>
        ))}
        {parts.footer ? <View style={{ paddingHorizontal: space.sm, opacity: 0.7 }}><Markdown source={parts.footer} /></View> : null}
      </View>
      <Sheet visible={more} onClose={() => setMore(false)} title="Report actions">
        <Group>
          <Row icon="download-outline" title="Export .md" subtitle="Markdown file in a folder you choose" onPress={fromSheet(() => doExport('md'))} />
          <Row icon="document-text-outline" title="Export .txt" subtitle="Plain text file" onPress={fromSheet(() => doExport('txt'))} />
          <Row icon="copy-outline" title="Copy" subtitle="Plain text to the clipboard" onPress={fromSheet(() => Clipboard.setStringAsync(markdownToPlainText(r.markdown)).then(() => Alert.alert('Copied', 'The report text is on your clipboard.')))} />
          <Row icon="share-outline" title="Share text" subtitle="Send the Markdown to another app" onPress={fromSheet(() => run(() => shareReport(r)))} />
          <Row icon="refresh" title="Regenerate" subtitle="Rebuild from your current library" onPress={fromSheet(() => run(async () => { const n = await regenerateReport(r); navigation.replace('ReportDetail', { id: n.id }); }))} />
        </Group>
      </Sheet>
    </Screen>
  );
}
