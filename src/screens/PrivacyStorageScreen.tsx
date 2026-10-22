import * as FS from 'expo-file-system/legacy';
import React from 'react';
import { Alert } from 'react-native';
import type { RootProps } from '../navigation/types';
import { getRepo } from '../services/db';
import { emit } from '../services/events';
import { exportLibrary } from '../services/reports';
import { disconnect, getConnection } from '../services/server';
import { Banner, Button, Card, Header, Screen, Section, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { space } from '../ui/theme';

export default function PrivacyStorageScreen({ navigation }: RootProps<'PrivacyStorage'>) {
  const { busy, run } = useAction();
  const stats = useQuery(async (repo) => {
    let mediaBytes = 0;
    try {
      const dir = `${FS.documentDirectory}media/`;
      if ((await FS.getInfoAsync(dir)).exists) {
        for (const n of await FS.readDirectoryAsync(dir)) {
          const i = await FS.getInfoAsync(dir + n);
          if (i.exists && 'size' in i) mediaBytes += i.size ?? 0;
        }
      }
    } catch {
      /* best effort */
    }
    return {
      items: await repo.countWhere('1 = 1'),
      transcripts: await repo.transcriptCount(),
      reports: (await repo.listReports(1000)).length,
      mediaMb: (mediaBytes / 1048576).toFixed(1),
    };
  }, ['items', 'reports']);

  return (
    <Screen>
      <Header title="Privacy & storage" onBack={() => navigation.goBack()} />
      <Card>
        <T v="subtitle">On this phone</T>
        {stats.data ? <T color="textMuted">{stats.data.items} items · {stats.data.transcripts} transcripts · {stats.data.reports} reports · {stats.data.mediaMb} MB of imported media</T> : null}
        <T v="small" color="textMuted" style={{ marginTop: space.sm }}>Stored in Qivra’s private app storage. Android backup is disabled for this app, so the library is not copied to cloud backups.</T>
      </Card>
      <Section title="What leaves this phone">
        <T v="small" color="textMuted">• Public metadata lookups for links you save (YouTube oEmbed, GitHub API, the web page itself).</T>
        <T v="small" color="textMuted">• If paired: titles, notes, tags, summaries and collections sync to your own server. Transcripts and media are sent only when you ask for server processing.</T>
        <T v="small" color="textMuted">• If you configure an AI model: the saved text needed for that request. External providers require your consent first.</T>
        <T v="small" color="textMuted">• Nothing else: no analytics, no crash reporting, no ads.</T>
      </Section>
      <Section title="Export">
        <Button title="Export library (JSON)" icon="download-outline" loading={busy} onPress={() => void run(async () => {
          const r = await exportLibrary();
          if (!('cancelled' in r)) Alert.alert('Exported', 'Your library was written to the folder you chose and verified.');
        }, 'Export failed')} />
        <T v="caption" color="textFaint" style={{ marginTop: 4 }}>Includes items, notes, tags, collections, transcripts, reports and conversations. Credentials are never exported.</T>
      </Section>
      <Section title="Delete">
        <Banner tone="danger" title="Delete everything on this phone" body="Removes all items, transcripts, imported media, reports and conversations from this phone. It does not delete data on your server." action={
          <Button kind="danger" title="Delete all data" loading={busy} onPress={() => void run(async () => {
            if (!(await confirm('Delete all Qivra data?', 'This cannot be undone. Export first if you want a copy.', 'Delete everything', true))) return;
            if (!(await confirm('Are you sure?', 'All items, transcripts, media and reports on this phone will be erased.', 'Erase', true))) return;
            if (await getConnection()) await disconnect(false);
            const repo = await getRepo();
            await repo.deleteEverything();
            await FS.deleteAsync(`${FS.documentDirectory}media/`, { idempotent: true });
            emit('items', 'reports', 'collections', 'conversations', 'jobs');
            Alert.alert('Deleted', 'All Qivra data on this phone was erased.');
          })} />
        } />
      </Section>
    </Screen>
  );
}
