import { Ionicons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, type NativeScrollEvent, type NativeSyntheticEvent, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ActionProposal } from '../core/agent/agent';
import { ITEM_SUGGESTIONS } from '../core/agent/itemQa';
import { formatLocal } from '../core/dates';
import type { Message } from '../db/types';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { ask, askAboutItem, dropLastExchange } from '../services/agentService';
import { getRepo } from '../services/db';
import { generateReport } from '../services/reports';
import { type AskMode, AssistantMessage, Composer, SourcesSheet, StreamingMessage, UserBubble } from '../ui/chat/ChatParts';
import { Backdrop, Banner, Button, IconButton, Sheet, T } from '../ui/components';
import { confirm, useQuery } from '../ui/hooks';
import { radius, space, useTheme } from '../ui/theme';
import { useAiInfo, useSettings } from '../ui/useSettings';
import { VoiceSheet } from '../ui/VoiceSheet';
import { useTabBarInset } from '../ui/nav/FloatingTabBar';

type Props = CompositeScreenProps<BottomTabScreenProps<TabParamList, 'Agent'>, NativeStackScreenProps<RootStackParamList>>;

const SUGGESTIONS: { icon: keyof typeof Ionicons.glyphMap; title: string; prompt: string }[] = [
  { icon: 'today-outline', title: 'What did I save today?', prompt: 'What did I save today? Summarise it briefly.' },
  { icon: 'git-compare-outline', title: 'Compare my GitHub projects', prompt: 'Compare the GitHub projects I saved.' },
  { icon: 'school-outline', title: 'Make a learning plan', prompt: 'Create a learning plan from the tutorials I saved.' },
  { icon: 'construct-outline', title: 'Tools and repos mentioned', prompt: 'List every repository and development tool mentioned in my transcripts.' },
];

interface Live {
  question: string;
  text: string;
  status: 'searching' | 'writing';
}

export default function AgentScreen({ navigation, route }: Props) {
  const { c } = useTheme();
  const ai = useAiInfo();
  const settings = useSettings();
  const [convId, setConvId] = useState<string | null>(route.params?.conversationId ?? null);
  const [scopeId, setScopeId] = useState<string | null>(route.params?.itemId ?? null);
  // Opening "Ask about this" again (or for another item) starts a fresh scoped conversation.
  useEffect(() => {
    if (route.params?.itemId) {
      setScopeId(route.params.itemId);
      setConvId(null);
    }
  }, [route.params?.itemId]);
  const scopeItem = useQuery(async (repo) => (scopeId ? repo.getItem(scopeId) : null), ['items'], [scopeId]);
  const [input, setInput] = useState(route.params?.prompt ?? '');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [voice, setVoice] = useState(false);
  const [sourcesFor, setSourcesFor] = useState<Message | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [mode, setMode] = useState<AskMode>('library');
  const inset = useTabBarInset();
  // The floating tab bar hides while typing, so the composer only needs to clear it when the keyboard is down.
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const a = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true));
    const b = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false));
    return () => { a.remove(); b.remove(); };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<Message>>(null);
  const atBottom = useRef(true);
  // Streamed text arrives token by token; render it at most ~20 times a second.
  const pending = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const msgs = useQuery(async (repo) => (convId ? repo.listMessages(convId) : []), ['conversations'], [convId]);
  const convs = useQuery((repo) => repo.listConversations(), ['conversations']);
  const titles = useQuery(async (repo) => {
    const ids = [...new Set((msgs.data ?? []).flatMap((m) => m.citations.map((ci) => ci.itemId)))];
    return Object.fromEntries((await repo.itemsByIds(ids)).map((i) => [i.id, i.title || i.url || 'Untitled'])) as Record<string, string>;
  }, ['items', 'conversations'], [msgs.data]);

  const scrollToEnd = useCallback((force = false) => {
    if (force || atBottom.current) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 30);
  }, []);
  useEffect(() => { scrollToEnd(true); }, [msgs.data?.length, scrollToEnd]);

  const flush = () => {
    flushTimer.current = null;
    const add = pending.current;
    pending.current = '';
    if (add) setLive((l) => (l ? { ...l, text: l.text + add, status: 'writing' } : l));
    scrollToEnd();
  };

  const send = async (text: string, modeOverride?: AskMode) => {
    const askMode = modeOverride ?? mode;
    const q = text.trim();
    if (!q || live) return;
    setInput('');
    setError(null);
    const ctl = new AbortController();
    abortRef.current = ctl;
    atBottom.current = true;
    setLive({ question: q, text: '', status: 'searching' });
    const stream = {
      onDelta: (t: string) => {
        pending.current += t;
        if (!flushTimer.current) flushTimer.current = setTimeout(flush, 50);
      },
      onRoundReset: () => { pending.current = ''; setLive((l) => (l ? { ...l, text: '' } : l)); },
      onStatus: (status: Live['status']) => setLive((l) => (l ? { ...l, status } : l)),
      onConversation: (id: string) => setConvId(id),
      signal: ctl.signal,
      mode: askMode,
    };
    try {
      const r = scopeId ? await askAboutItem(convId, scopeId, q, stream) : await ask(convId, q, stream);
      setConvId(r.conversationId);
    } catch (e) {
      setError((e as Error).message || 'The assistant failed.');
    } finally {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      pending.current = '';
      abortRef.current = null;
      setLive(null);
    }
  };

  const regenerate = async (modeOverride?: AskMode) => {
    if (!convId || live) return;
    const q = await dropLastExchange(convId);
    if (q) await send(q, modeOverride);
  };
  // "Answer generally": switch to General and ask the same question again.
  const answerGenerally = () => {
    setMode('general');
    void regenerate('general');
  };

  const runProposal = async (p: ActionProposal) => {
    if (p.tool !== 'create_report') return;
    const args = p.args as { kind?: string; topic?: string };
    if (!(await confirm('Create report?', `Generate a ${args.kind ?? 'topic'} report${args.topic ? ` about “${args.topic}”` : ''} from your saved items?`, 'Create'))) return;
    const r = await generateReport({ kind: (args.kind === 'weekly' ? 'weekly' : args.kind === 'daily' ? 'daily' : 'topic') as 'daily', topic: args.topic, useAi: ai?.enabled });
    navigation.navigate('ReportDetail', { id: r.id });
  };

  const openSource = (itemId: string, startMs: number | null) => navigation.navigate('ItemDetail', { id: itemId, at: startMs ?? undefined });
  const citeIn = (m: Message) => (sid: string) => {
    const ci = m.citations.find((x) => x.sid === sid);
    if (ci) openSource(ci.itemId, ci.startMs);
  };

  const newChat = () => {
    abortRef.current?.abort();
    setConvId(null);
    setScopeId(null);
    setError(null);
  };

  const data = msgs.data ?? [];
  const lastAssistant = [...data].reverse().find((m) => m.role === 'assistant');
  // While streaming, the stored question already shows; the live answer goes below it.
  const showLive = !!live && (data.length === 0 || data[data.length - 1].role === 'user');
  const empty = !data.length && !live;
  const subtitle = !ai?.enabled ? 'No AI model · answers quote your saved items'
    : `${mode === 'general' && !scopeId ? 'General chat' : 'Your library'} · ${ai.model}${ai.source === 'server' ? ' via your server' : ''}`;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <Backdrop />
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space.xs, borderBottomWidth: empty ? 0 : 1, borderColor: c.border }}>
        <IconButton icon="menu-outline" label="Conversation history" onPress={() => setHistoryOpen(true)} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <T v="subtitle" accessibilityRole="header" numberOfLines={1}>{scopeId ? 'Ask about this' : 'Ask'}</T>
          <T v="caption" color="textMuted" numberOfLines={1}>{subtitle}</T>
        </View>
        <IconButton icon="create-outline" label="New chat" onPress={newChat} />
      </View>
      {scopeId ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginHorizontal: space.lg, marginTop: space.sm, padding: space.sm, paddingLeft: space.md, borderRadius: radius.lg, backgroundColor: c.accentSoft }}>
          <Ionicons name="play-circle-outline" size={18} color={c.accent} />
          <T v="small" style={{ flex: 1, marginLeft: space.sm }} numberOfLines={2} accessibilityLiveRegion="polite">Asking about: <T v="small" style={{ fontWeight: '700' }}>{scopeItem.data?.title || scopeItem.data?.url || 'this item'}</T></T>
          <IconButton icon="close" label="Ask the whole library instead" onPress={() => { setScopeId(null); setConvId(null); }} />
        </View>
      ) : null}
      <KeyboardAvoidingView behavior="height" style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          data={data}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: space.lg, paddingBottom: space.md, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
          }}
          scrollEventThrottle={100}
          ListEmptyComponent={empty ? (
            <View style={{ flex: 1, justifyContent: 'center', paddingVertical: space.xl }}>
              <View style={{ alignItems: 'center', marginBottom: space.xl }}>
                <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="sparkles" size={28} color={c.accent} />
                </View>
                <T v="title" style={{ marginTop: space.md, textAlign: 'center' }}>{scopeId ? 'What do you want to know about it?' : 'What do you want to know?'}</T>
                <T color="textMuted" style={{ textAlign: 'center', marginTop: 4 }}>Answers come from what you saved, with sources you can open.</T>
              </View>
              {!ai?.enabled ? <Banner tone="info" title="Works without AI" body="Without a model, Qivra answers with the matching passages from your library. Connect your server or add a model for written answers." action={<Button kind="outline" title="AI models" onPress={() => navigation.navigate('AiProviders')} />} /> : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {(scopeId ? ITEM_SUGGESTIONS.map((p) => ({ icon: 'chatbubble-ellipses-outline' as const, title: p, prompt: p })) : SUGGESTIONS).map((s) => (
                  <Pressable key={s.title} onPress={() => void send(s.prompt)} accessibilityRole="button" accessibilityLabel={s.title}
                    style={({ pressed }) => ({ width: '48.5%', minHeight: 84, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surfaceAlt : c.surface })}>
                    <Ionicons name={s.icon} size={20} color={c.accent} />
                    <T v="small" style={{ marginTop: space.xs, fontWeight: '600' }} numberOfLines={3}>{s.title}</T>
                  </Pressable>
                ))}
              </View>
              {!scopeId ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
                  <Button kind="text" title="Today's report" icon="document-text-outline" onPress={() => void generateReport({ kind: 'daily', useAi: ai?.enabled }).then((r) => navigation.navigate('ReportDetail', { id: r.id }))} />
                  <Button kind="text" title="All reports" icon="folder-open-outline" onPress={() => navigation.navigate('Reports')} />
                </View>
              ) : null}
            </View>
          ) : null}
          renderItem={({ item: m }) => m.role === 'user' ? <UserBubble text={m.content} /> : (
            <AssistantMessage
              message={m}
              isLast={m.id === lastAssistant?.id && !live}
              onCite={citeIn(m)}
              onTime={m.citations[0] ? (ms) => openSource(m.citations[0].itemId, ms) : undefined}
              onSources={() => setSourcesFor(m)}
              onRegenerate={() => void regenerate(m.mode === 'general' ? 'general' : undefined)}
              footer={<>
                {/* Nothing usable from the library (no match, or an answer citing nothing): offer a general answer. */}
                {(m.mode === 'no_evidence' || (m.mode === 'model' && !m.citations.length)) && m.id === lastAssistant?.id && !live && !scopeId && ai?.enabled ? (
                  <Button kind="tonal" title="Answer generally" icon="globe-outline" onPress={answerGenerally} style={{ alignSelf: 'flex-start', marginTop: space.sm }}
                    accessibilityHint="Asks again in General mode; the answer will not come from your library" />
                ) : null}
                {(m.proposals as ActionProposal[]).map((p, i) => (
                  <Banner key={i} tone="accent" title={`Suggested: ${p.tool.replace(/_/g, ' ')}`} body={`${p.reason} Nothing happens until you confirm.`} action={p.tool === 'create_report' ? <Button kind="outline" title="Review & create" onPress={() => void runProposal(p)} /> : undefined} />
                ))}
              </>}
            />
          )}
          ListFooterComponent={
            <>
              {showLive && live ? <StreamingMessage text={live.text} status={live.status} /> : null}
              {error ? <Banner tone="danger" title="Couldn't answer" body={error} action={<Button kind="outline" title="Try again" onPress={() => void regenerate()} />} /> : null}
            </>
          }
        />
        <Composer
          value={input}
          onChange={setInput}
          onSend={() => void send(input)}
          onStop={() => abortRef.current?.abort()}
          onVoice={() => setVoice(true)}
          streaming={!!live}
          placeholder={scopeId ? 'Ask about this item…' : mode === 'general' ? 'Ask anything…' : 'Ask about your library…'}
          mode={scopeId ? undefined : mode}
          bottomInset={keyboard ? 0 : inset}
          onToggleMode={() => setMode((m) => (m === 'library' ? 'general' : 'library'))}
        />
      </KeyboardAvoidingView>
      <VoiceSheet visible={voice} onClose={() => setVoice(false)} purpose="dictate" onText={setInput} onOpenSettings={() => navigation.navigate('VoiceSettings')} />
      <SourcesSheet message={sourcesFor} titles={titles.data ?? {}} onClose={() => setSourcesFor(null)} onOpen={openSource} />
      <Sheet visible={historyOpen} onClose={() => setHistoryOpen(false)} title="Chats">
        <Button kind="outline" title="New chat" icon="create-outline" onPress={() => { newChat(); setHistoryOpen(false); }} style={{ marginBottom: space.sm }} />
        {(convs.data ?? []).map((cv) => (
          <View key={cv.id} style={{ flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, backgroundColor: cv.id === convId ? c.surfaceAlt : 'transparent' }}>
            <Pressable onPress={() => { setScopeId(null); setConvId(cv.id); setHistoryOpen(false); }} accessibilityRole="button" accessibilityLabel={cv.title} style={{ flex: 1, paddingVertical: space.sm, paddingHorizontal: space.sm }}>
              <T v="small" numberOfLines={1} style={{ fontWeight: '600' }}>{cv.title}</T>
              <T v="caption" color="textFaint">{formatLocal(cv.updatedAt, settings?.timezone ?? 'UTC', { dateStyle: 'medium', timeStyle: 'short' })}</T>
            </Pressable>
            <IconButton icon="trash-outline" label={`Delete ${cv.title}`} onPress={() => void (async () => { await (await getRepo()).deleteConversation(cv.id); if (convId === cv.id) setConvId(null); await convs.reload(); })()} />
          </View>
        ))}
        {!convs.data?.length ? <T color="textMuted">No chats yet.</T> : null}
      </Sheet>
    </SafeAreaView>
  );
}
