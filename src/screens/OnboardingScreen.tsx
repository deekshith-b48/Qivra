/**
 * First run: four short swipeable pages about what Qivra does, then a setup
 * checklist (notifications, your laptop server, AI answers). Everything on the
 * checklist is optional; "Get started" always works.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import React, { useEffect, useRef, useState } from 'react';
import { Linking, type NativeScrollEvent, type NativeSyntheticEvent, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { RootProps, RootStackParamList } from '../navigation/types';
import { getRepo } from '../services/db';
import { SECRET_KEYS, setSecret } from '../services/secure';
import { getSettings, updateSettings } from '../services/settings';
import { createOpenAICompatProvider, ProviderError } from '../core/ai/provider';
import { Backdrop, Button, elevation, Field, type IconName, T, Wordmark } from '../ui/components';
import { radius, space, useTheme } from '../ui/theme';
import { IconTile } from '../ui/tiles';
import type { TintName } from '../ui/tokens';

const PAGES: { icon: IconName; tint: TintName; title: string; body: string }[] = [
  { icon: 'sparkles', tint: 'purple', title: 'Turn what you save into what you know.', body: 'A private knowledge vault for reels, videos, posts, pages and notes. It lives on your phone first.' },
  { icon: 'share-social', tint: 'blue', title: 'Save from anywhere', body: 'Share a reel, video, post or page to Qivra and keep scrolling. You get a notification when it is ready. Notes, voice and files too.' },
  { icon: 'library', tint: 'orange', title: 'Understand it', body: 'Transcripts, summaries, key moments and keywords for everything you save, searchable even offline.' },
  { icon: 'bulb', tint: 'green', title: 'Ask and remember', body: 'Ask questions and get answers that cite your saved items. Flashcards in Glance help you remember.' },
];

type Notif = 'unknown' | 'granted' | 'denied';

/** The user's own Groq key; same endpoint and model as the AI models preset. */
const GROQ = { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' };

export default function OnboardingScreen({ navigation }: RootProps<'Onboarding'>) {
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const scroller = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const [notif, setNotif] = useState<Notif>('unknown');
  const devPage = PAGES.length; // "Are you a developer?"
  const aiPage = PAGES.length + 1; // your own Groq key
  const last = PAGES.length + 2; // the setup page
  const [dev, setDev] = useState<boolean | null>(null);
  const [groqKey, setGroqKey] = useState('');
  const [ai, setAi] = useState<{ state: 'idle' | 'checking' | 'ok' } | { state: 'error'; message: string }>({ state: 'idle' });

  useEffect(() => {
    void Notifications.getPermissionsAsync().then((p) => p.granted && setNotif('granted')).catch(() => undefined);
  }, []);

  const goTo = (i: number) => {
    scroller.current?.scrollTo({ x: i * width, animated: true });
    setPage(i);
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => setPage(Math.round(e.nativeEvent.contentOffset.x / width));

  /** Mark onboarding done, then open Home (and optionally one setup screen on top of it). */
  const finish = async (next?: keyof RootStackParamList) => {
    await (await getRepo()).setMeta('app.onboarded', '1');
    navigation.reset({ index: next ? 1 : 0, routes: next ? [{ name: 'Main' }, { name: next as never }] : [{ name: 'Main' }] });
  };
  /** Check the user's own Groq key with a tiny request, then store it (secure storage) and turn AI on. */
  const saveGroq = async () => {
    const key = groqKey.trim();
    if (!key) return;
    setAi({ state: 'checking' });
    try {
      const p = createOpenAICompatProvider({ baseUrl: GROQ.baseUrl, model: GROQ.model, apiKey: key, timeoutMs: 20_000 });
      await p.chat([{ role: 'user', content: 'Reply with the single word: ok' }], { maxTokens: 5 });
      await setSecret(SECRET_KEYS.aiApiKey, key);
      const cur = (await getSettings()).ai;
      await updateSettings({ ai: { ...cur, enabled: true, baseUrl: GROQ.baseUrl, model: GROQ.model, embeddingModel: '', externalConsent: true } });
      setGroqKey('');
      setAi({ state: 'ok' });
      goTo(last);
    } catch (e) {
      const code = e instanceof ProviderError ? e.code : 'NETWORK';
      setAi({ state: 'error', message: code === 'AUTH' ? 'Groq rejected this key. Copy it again from console.groq.com/keys.' : code === 'RATE_LIMIT' ? 'Groq is busy right now. Try again in a minute.' : 'Could not reach Groq. Check your connection and try again.' });
    }
  };

  const askNotifications = async () => {
    try {
      const p = await Notifications.requestPermissionsAsync();
      setNotif(p.granted ? 'granted' : 'denied');
    } catch {
      setNotif('denied');
    }
  };

  const setupRows: { icon: IconName; tint: TintName; title: string; body: string; action: string; done?: boolean; onPress: () => void }[] = [
    {
      icon: 'notifications', tint: 'red', title: 'Notifications', body: 'So Qivra can tell you when a shared reel or page is ready.',
      action: notif === 'granted' ? 'Allowed' : notif === 'denied' ? 'Not now' : 'Allow', done: notif === 'granted', onPress: () => void askNotifications(),
    },
    { icon: 'laptop', tint: 'indigo', title: 'Connect your laptop', body: 'Scan the QR code from the Qivra server for transcription, AI and sync.', action: 'Connect', onPress: () => void finish('ConnectServer') },
    {
      icon: 'sparkles', tint: 'pink', title: 'AI answers', body: ai.state === 'ok' ? 'Using your own Groq key.' : 'Add your free Groq key, or use your laptop server\'s AI.',
      action: ai.state === 'ok' ? 'Groq' : 'Add key', done: ai.state === 'ok', onPress: () => (ai.state === 'ok' ? void finish('AiProviders') : goTo(aiPage)),
    },
  ];

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <Backdrop />
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.sm, minHeight: 48 }}>
        <View style={{ flex: 1 }}><Wordmark size={24} /></View>
        {page < last ? <Button kind="text" title="Skip" onPress={() => goTo(last)} /> : null}
      </View>

      <ScrollView ref={scroller} horizontal pagingEnabled showsHorizontalScrollIndicator={false} onMomentumScrollEnd={onScroll} style={{ flex: 1 }}>
        {PAGES.map((p) => (
          <View key={p.title} style={{ width, paddingHorizontal: space.xl, justifyContent: 'center', alignItems: 'center' }}>
            <IconTile icon={p.icon} tint={p.tint} size={72} />
            <T v="display" style={{ marginTop: space.xl, textAlign: 'center' }} accessibilityRole="header">{p.title}</T>
            <T color="textMuted" style={{ marginTop: space.md, textAlign: 'center', lineHeight: 24 }}>{p.body}</T>
          </View>
        ))}
        <View style={{ width, paddingHorizontal: space.xl, justifyContent: 'center', alignItems: 'center' }}>
          <IconTile icon="code-slash" tint="indigo" size={72} />
          <T v="display" style={{ marginTop: space.xl, textAlign: 'center' }} accessibilityRole="header">Are you a developer?</T>
          <T color="textMuted" style={{ marginTop: space.md, textAlign: 'center', lineHeight: 24 }}>
            Dev Mode adds a Dev tab: AI and dev trends, Claude Code skills, plugins and MCP servers, follow-ups on topics you choose, and daily dev habits.
          </T>
          <T v="caption" color="textFaint" style={{ marginTop: space.sm, textAlign: 'center' }}>It reads public feeds from GitHub, Hacker News and Hugging Face. Your library is never sent.</T>
          <View style={{ alignSelf: 'stretch', gap: space.sm, marginTop: space.xl }}>
            <Button title={dev ? 'Dev Mode is on' : 'Turn on Dev Mode'} icon={dev ? 'checkmark' : 'code-slash-outline'} onPress={() => void updateSettings({ devMode: true }).then(() => { setDev(true); goTo(aiPage); })} />
            <Button kind="outline" title="Not now" onPress={() => void updateSettings({ devMode: false }).then(() => { setDev(false); goTo(aiPage); })} />
          </View>
        </View>
        <ScrollView style={{ width }} contentContainerStyle={{ paddingHorizontal: space.xl, paddingTop: space.xl, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
          <IconTile icon="sparkles" tint="purple" size={72} />
          <T v="display" style={{ marginTop: space.lg, textAlign: 'center' }} accessibilityRole="header">Turn on AI answers</T>
          <T color="textMuted" style={{ marginTop: space.sm, textAlign: 'center', lineHeight: 22 }}>
            Qivra uses Groq's free, fast AI for summaries and Ask. Use your own free key: it stays on this phone in Android's secure storage.
          </T>
          <Button kind="outline" title="Get a free Groq key" icon="key-outline" style={{ marginTop: space.md }} onPress={() => void Linking.openURL('https://console.groq.com/keys')} />
          <View style={{ alignSelf: 'stretch', marginTop: space.md }}>
            <Field label="Your Groq API key" value={groqKey} onChangeText={(t) => { setGroqKey(t); if (ai.state === 'error') setAi({ state: 'idle' }); }}
              placeholder="gsk_…" secureTextEntry autoCapitalize="none" autoCorrect={false} error={ai.state === 'error' ? ai.message : null} />
            <T v="caption" color="textFaint" style={{ marginTop: space.xs }}>When you ask or summarise, the relevant saved text is sent to Groq. Its privacy policy applies.</T>
            <Button title={ai.state === 'ok' ? 'Groq connected' : 'Verify & save'} icon={ai.state === 'ok' ? 'checkmark' : 'shield-checkmark-outline'} loading={ai.state === 'checking'}
              disabled={!groqKey.trim() || ai.state === 'checking'} style={{ marginTop: space.md }} onPress={() => void saveGroq()} />
          </View>
        </ScrollView>
        <ScrollView style={{ width }} contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: space.lg }}>
          <T v="display" accessibilityRole="header">Set up Qivra</T>
          <T color="textMuted" style={{ marginTop: space.xs }}>All optional. You can change these any time in Settings.</T>
          <View style={[{ marginTop: space.lg, borderRadius: radius.card, backgroundColor: c.surface, paddingHorizontal: space.md }, elevation(c)]}>
            {setupRows.map((r, i) => (
              <Pressable key={r.title} onPress={r.onPress} accessibilityRole="button" accessibilityLabel={`${r.title}: ${r.action}`} accessibilityHint={r.body}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, borderTopWidth: i ? 1 : 0, borderColor: c.border, opacity: pressed ? 0.6 : 1 })}>
                <IconTile icon={r.icon} tint={r.tint} size={40} />
                <View style={{ flex: 1 }}>
                  <T v="subtitle">{r.title}</T>
                  <T v="caption" color="textMuted">{r.body}</T>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {r.done ? <Ionicons name="checkmark-circle" size={18} color={c.tint.green} /> : null}
                  <T v="small" style={{ color: r.done ? c.tint.green : c.accent, fontWeight: '700' }}>{r.action}</T>
                </View>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </ScrollView>

      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.lg }}>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: space.lg }} accessibilityLabel={`Page ${page + 1} of ${last + 1}`}>
          {[...PAGES, null, null, null].map((_, i) => (
            <View key={i} style={{ width: i === page ? 22 : 7, height: 7, borderRadius: 4, backgroundColor: i === page ? c.text : c.border }} />
          ))}
        </View>
        {page < devPage
          ? <Button title="Next" onPress={() => goTo(page + 1)} />
          : page === devPage
          ? <Button kind="text" title="Decide later" onPress={() => goTo(aiPage)} />
          : page === aiPage
          ? <Button kind="text" title="Later" onPress={() => goTo(last)} />
          : <Button title="Get started" onPress={() => void finish()} />}
      </View>
    </SafeAreaView>
  );
}
