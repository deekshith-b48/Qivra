/**
 * Settings in the iOS style: a summary card, then grouped rows with coloured
 * icons, the current value on the right and a chevron. Long explanations live
 * in subtitles only where a choice needs them.
 */

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import React from 'react';
import { Alert, Linking, View } from 'react-native';
import { isValidTimeZone } from '../core/dates';
import type { RootProps } from '../navigation/types';
import { disableDailyReminder, enableDailyReminder } from '../services/reminders';
import { deviceTimeZone, updateSettings } from '../services/settings';
import { enableWeeklyReport } from '../services/weeklyReport';
import { Button, Card, Field, Group, Header, Row, Screen, Section, Sheet, T, ToggleRow, Wordmark } from '../ui/components';
import { useQuery } from '../ui/hooks';
import { Segmented } from '../ui/media';
import { space, useTheme } from '../ui/theme';
import { useAiInfo, useSettings } from '../ui/useSettings';

export default function SettingsScreen({ navigation }: RootProps<'Settings'>) {
  const { c } = useTheme();
  const s = useSettings();
  const ai = useAiInfo();
  const counts = useQuery(async (repo) => ({
    jobs: await repo.jobCounts(),
    items: await repo.countWhere('1 = 1'),
    shelves: await repo.shelfCounts(),
    reminders: (await repo.upcomingReminders(new Date().toISOString(), 100)).length,
  }), ['jobs', 'items']);
  const notif = useQuery(async () => {
    try {
      return await Notifications.getPermissionsAsync();
    } catch {
      return null;
    }
  }, ['settings']);
  const [tzOpen, setTzOpen] = React.useState(false);
  const [tz, setTz] = React.useState('');
  React.useEffect(() => setTz(s?.timezone ?? ''), [s?.timezone]);
  if (!s) return <Screen><Header title="Settings" onBack={() => navigation.goBack()} /></Screen>;
  const j = counts.data?.jobs;
  const n = counts.data;
  const t = c.tint;
  const askNotifications = async () => {
    const cur = notif.data;
    if (cur?.granted) return;
    if (cur && !cur.canAskAgain) return void Linking.openSettings();
    await Notifications.requestPermissionsAsync().catch(() => undefined);
    await notif.reload();
  };

  return (
    <Screen>
      <Header title="Settings" onBack={() => navigation.goBack()} />

      {/* Summary */}
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <Wordmark size={24} />
          <T v="caption" color="textMuted" style={{ marginTop: 4 }}>Version {Constants.expoConfig?.version ?? '—'}{n ? ` · ${n.items} item${n.items === 1 ? '' : 's'}` : ''}</T>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} accessibilityLabel={`AI: ${ai?.enabled ? 'on' : 'off'}`}>
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: ai?.enabled ? t.green : t.gray }} />
          <T v="caption" color="textMuted">{ai?.enabled ? 'AI on' : 'AI off'}</T>
        </View>
      </Card>

      <Section title="AI & processing">
        <Group>
          <Row icon="hardware-chip" tint={t.pink} title="AI models" value={ai?.enabled ? ai.model ?? 'On' : 'Off'} subtitle={ai?.enabled ? 'Your own key: answers, summaries and video transcripts' : 'Add your free Groq key for AI and video transcripts'} onPress={() => navigation.navigate('AiProviders')} />
          <Row icon="mic" tint={t.red} title="Speech & dictation" value={s.voice.modelId.startsWith('parakeet') ? 'Parakeet' : 'Whisper'} onPress={() => navigation.navigate('VoiceSettings')} />
          <ToggleRow icon="videocam" tint={t.blue} title="Auto-transcribe shared videos" subtitle="YouTube captions directly; X videos and shared video files with your Groq key." value={s.autoTranscribe} onChange={(v) => void updateSettings({ autoTranscribe: v })} />
          <Row icon="time" tint={t.gray} title="Processing queue" value={j ? `${j.queued + j.running} pending${j.failed_retryable + j.failed_permanent ? ` · ${j.failed_retryable + j.failed_permanent} failed` : ''}` : undefined} onPress={() => navigation.navigate('Jobs')} />
        </Group>
      </Section>

      <Section title="Library">
        <Group>
          <Row icon="bookmark" tint={t.orange} title="Highlights" value={String(n?.shelves.highlights ?? '')} onPress={() => navigation.navigate('Highlights')} />
          <Row icon="star" tint={t.yellow} title="Favourites" value={String(n?.shelves.favorites ?? '')} onPress={() => navigation.navigate('Main', { screen: 'Library' })} />
          <Row icon="notifications" tint={t.orange} title="Revisit reminders" value={n?.reminders ? `${n.reminders} upcoming` : 'None'} onPress={() => navigation.navigate('Main', { screen: 'Glance' })} />
          <Row icon="albums" tint={t.blue} title="Collections" onPress={() => navigation.navigate('Collections')} />
        </Group>
        <View style={{ marginTop: space.sm }}>
          <Segmented options={[{ key: 'grid', label: 'Grid view' }, { key: 'list', label: 'List view' }]} value={s.libraryView === 'grid' ? 'grid' : 'list'} onChange={(k) => void updateSettings({ libraryView: k })} />
        </View>
      </Section>

      <Section title="Notifications">
        <Group>
          <Row icon="notifications" tint={t.red} title="Notifications" value={notif.data?.granted ? 'Allowed' : 'Off'} subtitle={notif.data?.granted ? undefined : 'Needed for "Ready" alerts, reminders and digests'} onPress={() => void askNotifications()} />
          <ToggleRow icon="sunny" tint={t.yellow} title="Daily digest (9 am)" subtitle="What is ready to review, each morning." value={s.dailyReminder} onChange={async (v) => {
            if (v) {
              const r = await enableDailyReminder();
              if (r === 'denied') return Alert.alert('Notifications are off', 'Allow notifications for Qivra in Android settings to use reminders.');
            } else await disableDailyReminder();
            await updateSettings({ dailyReminder: v });
          }} />
          <ToggleRow icon="calendar" tint={t.teal} title="Weekly report (Monday)" subtitle="Last week's report, prepared once and announced." value={s.weeklyReport} onChange={async (v) => {
            if (v && (await enableWeeklyReport()) === 'denied') return Alert.alert('Notifications are off', 'Allow notifications for Qivra in Android settings to use reminders.');
            await updateSettings({ weeklyReport: v });
          }} />
          <ToggleRow icon="document-text" tint={t.purple} title="Prepare yesterday's report" subtitle="In the background when Android allows." value={s.scheduledDailyReport} onChange={(v) => void updateSettings({ scheduledDailyReport: v })} />
        </Group>
      </Section>

      <Section title="Developer">
        <Group>
          <ToggleRow icon="code-slash" tint={t.indigo} title="Developer mode" subtitle="A Dev tab with AI trends, Claude Code skills and plugins, follow-ups and daily habits. Reads public GitHub, Hacker News and Hugging Face feeds." value={s.devMode} onChange={(v) => void updateSettings({ devMode: v })} />
        </Group>
      </Section>

      <Section title="Appearance">
        <Segmented options={[{ key: 'system', label: 'System' }, { key: 'light', label: 'Light' }, { key: 'dark', label: 'Dark' }]} value={s.theme} onChange={(k) => void updateSettings({ theme: k })} />
        <View style={{ marginTop: space.sm }}>
          <Group>
            <Row icon="globe" tint={t.green} title="Time zone" value={s.timezone} subtitle="For “today”, reports and date questions" onPress={() => setTzOpen(true)} />
          </Group>
        </View>
      </Section>

      <Section title="Data">
        <Group>
          <Row icon="shield-checkmark" tint={t.green} title="Privacy & storage" subtitle="Export, delete, what leaves this phone" onPress={() => navigation.navigate('PrivacyStorage')} />
          <Row icon="information-circle" tint={t.gray} title="About Qivra" value={Constants.expoConfig?.version} onPress={() => navigation.navigate('About')} />
        </Group>
      </Section>

      <Sheet visible={tzOpen} onClose={() => { setTzOpen(false); setTz(s.timezone); }} title="Time zone">
        <Button kind="outline" title={`Use this phone's time zone (${deviceTimeZone()})`} icon="phone-portrait-outline" onPress={() => void updateSettings({ timezone: deviceTimeZone() }).then(() => setTzOpen(false))} />
        <Field label="Or type an IANA time zone" value={tz} onChangeText={setTz} autoCapitalize="none" autoCorrect={false} help="For example Asia/Kolkata or Europe/Berlin" style={{ marginTop: space.md }} />
        <Button title="Save" style={{ marginTop: space.sm }} onPress={() => {
          if (!isValidTimeZone(tz)) return Alert.alert('Unknown time zone', 'Use a name like Asia/Kolkata or Europe/Berlin.');
          void updateSettings({ timezone: tz }).then(() => setTzOpen(false));
        }} />
      </Sheet>
    </Screen>
  );
}
