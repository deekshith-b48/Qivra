import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { Alert, View } from 'react-native';
import { formatLocal } from '../core/dates';
import { markdownToPlainText } from '../core/reports';
import type { RootProps } from '../navigation/types';
import { getRepo } from '../services/db';
import { emit } from '../services/events';
import { exportReport, regenerateReport, shareReport } from '../services/reports';
import { Banner, Button, Card, Header, IconButton, Loading, Screen, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { Markdown } from '../ui/Markdown';
import { space, useTheme } from '../ui/theme';

export default function ReportDetailScreen({ navigation, route }: RootProps<'ReportDetail'>) {
  const { c } = useTheme();
  const { busy, run } = useAction();
  const q = useQuery((repo) => repo.getReport(route.params.id), ['reports'], [route.params.id]);
  const r = q.data;
  if (q.loading && !r) return <Screen><Loading /></Screen>;
  if (!r) return <Screen><Header title="Report" onBack={() => navigation.goBack()} /><Banner tone="warning" title="Report not found" /></Screen>;

  const doExport = (fmt: 'md' | 'txt') => run(async () => {
    const res = await exportReport(r, fmt);
    if ('cancelled' in res) return;
    Alert.alert('Exported', `Saved and verified as ${fmt === 'md' ? r.filename : r.filename.replace(/\.md$/, '.txt')} in the folder you chose.`);
  }, 'Export failed');

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
      <T v="caption" color="textMuted">{r.filename} · {formatLocal(r.createdAt, r.timezone)}{r.exportedAt ? ` · last exported ${formatLocal(r.exportedAt, r.timezone)}` : ''}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginVertical: space.md }}>
        <Button title="Export .md" icon="download-outline" onPress={() => void doExport('md')} loading={busy} />
        <Button kind="outline" title="Export .txt" onPress={() => void doExport('txt')} />
        <Button kind="outline" title="Share" icon="share-outline" onPress={() => void run(() => shareReport(r))} />
        <Button kind="outline" title="Copy" icon="copy-outline" onPress={() => void Clipboard.setStringAsync(markdownToPlainText(r.markdown)).then(() => Alert.alert('Copied', 'The report text is on your clipboard.'))} />
        <Button kind="text" title="Regenerate" icon="refresh" onPress={() => void run(async () => { const n = await regenerateReport(r); navigation.replace('ReportDetail', { id: n.id }); })} />
      </View>
      <T v="caption" color="textFaint" style={{ marginBottom: space.sm }}>PDF export is not offered: Markdown and plain text are exported through Android's folder picker and verified after writing.</T>
      <Card><Markdown source={r.markdown} /></Card>
    </Screen>
  );
}
