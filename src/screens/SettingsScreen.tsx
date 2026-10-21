import React from 'react';
import { Alert, View } from 'react-native';
import type { RootProps } from '../navigation/types';
import { disableDailyReminder, enableDailyReminder } from '../services/reminders';
import { deviceTimeZone, updateSettings } from '../services/settings';
import { Chip, Divider, Field, Header, Row, Screen, Section, T, ToggleRow } from '../ui/components';
import { useQuery } from '../ui/hooks';
import { space } from '../ui/theme';
import { useAiInfo, useConnection, useSettings } from '../ui/useSettings';
import { isValidTimeZone } from '../core/dates';

export default function SettingsScreen({ navigation }: RootProps<'Settings'>) {
  const s = useSettings();
  const ai = useAiInfo();
  const { connection } = useConnection();
  const counts = useQuery(async (repo) => ({ jobs: await repo.jobCounts(), conflicts: (await repo.openConflicts()).length }), ['jobs', 'conflicts']);
  const [tz, setTz] = React.useState('');
  React.useEffect(() => setTz(s?.timezone ?? ''), [s?.timezone]);
  if (!s) return <Screen><Header title="Settings" onBack={() => navigation.goBack()} /></Screen>;
  const j = counts.data?.jobs;

  return (
    <Screen>
      <Header title="Settings" onBack={() => navigation.goBack()} />
      <Section title="Connection">
        <Row icon="server-outline" title="Connect to My Server" subtitle={connection ? `${connection.lastError ? 'Problem' : 'Connected'} · ${connection.serverUrl}` : 'Not connected — everything stays on this phone'} onPress={() => navigation.navigate('ConnectServer')} />
        <Row icon="git-compare-outline" title="Sync conflicts" subtitle={counts.data?.conflicts ? `${counts.data.conflicts} to review` : 'None'} onPress={() => navigation.navigate('Conflicts')} />
      </Section>
      <Section title="AI & processing">
        <Row icon="mic-outline" title="Voice & dictation" subtitle={`On-device ${s.voice.modelId.startsWith('parakeet') ? 'Parakeet' : 'Whisper'} · ${s.voice.language === 'auto' ? 'auto language' : s.voice.language}${s.voice.preferServer ? ' · notes via server' : ''}`} onPress={() => navigation.navigate('VoiceSettings')} />
        <Row icon="sparkles-outline" title="AI models" subtitle={ai?.enabled ? `${ai.model} · ${ai.source === 'server' ? `via your Qivra server (${ai.where})` : ai.where}` : 'None — Qivra works without AI'} onPress={() => navigation.navigate('AiProviders')} />
        <ToggleRow title="Auto-transcribe shared videos" subtitle="YouTube captions are fetched on this phone. Instagram and X videos (and YouTube videos without captions) are transcribed by your paired server with local Whisper." value={s.autoTranscribe} onChange={(v) => void updateSettings({ autoTranscribe: v })} />
        <Row icon="list-outline" title="Processing queue" subtitle={j ? `${j.queued + j.running} pending · ${j.failed_retryable + j.failed_permanent} failed` : undefined} onPress={() => navigation.navigate('Jobs')} />
      </Section>
      <Section title="Appearance">
        <View style={{ flexDirection: 'row' }}>
          {(['system', 'light', 'dark'] as const).map((t) => <Chip key={t} label={t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'} selected={s.theme === t} onPress={() => void updateSettings({ theme: t })} />)}
        </View>
      </Section>
      <Section title="Time zone">
        <T v="small" color="textMuted">Used for “today”, daily reports and the agent’s date questions.</T>
        <Field label="IANA time zone" value={tz} onChangeText={setTz} autoCapitalize="none" autoCorrect={false}
          onEndEditing={() => {
            if (isValidTimeZone(tz)) void updateSettings({ timezone: tz });
            else {
              Alert.alert('Unknown time zone', 'Use a name like Asia/Kolkata or Europe/Berlin.');
              setTz(s.timezone);
            }
          }}
          help={`Device time zone: ${deviceTimeZone()}`} style={{ marginTop: space.sm }} />
      </Section>
      <Section title="Reminders & schedules">
        <ToggleRow title="Daily digest (9 am)" subtitle="What is ready to review, each morning. Shows item titles; hidden on a locked screen. Asks for notification permission when turned on." value={s.dailyReminder} onChange={async (v) => {
          if (v) {
            const r = await enableDailyReminder();
            if (r === 'denied') return Alert.alert('Notifications are off', 'Allow notifications for Qivra in Android settings to use reminders.');
          } else await disableDailyReminder();
          await updateSettings({ dailyReminder: v });
        }} />
        <ToggleRow title="Prepare yesterday's report automatically" subtitle="Runs in the background when Android allows (WorkManager; may be delayed by battery saver)." value={s.scheduledDailyReport} onChange={(v) => void updateSettings({ scheduledDailyReport: v })} />
      </Section>
      <Section title="Data">
        <Row icon="shield-checkmark-outline" title="Privacy & storage" subtitle="Export, delete, what leaves this phone" onPress={() => navigation.navigate('PrivacyStorage')} />
        <Row icon="information-circle-outline" title="About Qivra" subtitle="Version, licenses, SuperBrain attribution" onPress={() => navigation.navigate('About')} />
      </Section>
      <Divider />
    </Screen>
  );
}
