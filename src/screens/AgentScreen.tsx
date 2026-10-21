import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ActionProposal } from '../core/agent/agent';
import { formatTimestamp } from '../core/transcripts';
import type { Message } from '../db/types';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { ask } from '../services/agentService';
import { getRepo } from '../services/db';
import { generateReport } from '../services/reports';
import { Banner, Button, Chip, IconButton, Loading, Sheet, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { radius, space, type, useTheme } from '../ui/theme';
import { useSettings } from '../ui/useSettings';

type Props = CompositeScreenProps<BottomTabScreenProps<TabParamList, 'Agent'>, NativeStackScreenProps<RootStackParamList>>;

const SUGGESTIONS = [
  'What did I save today about Claude Code?',
  "Summarize this week's AI agent tutorials.",
  'Compare the GitHub projects I saved.',
  'Create a learning plan from my React and system-design videos.',
  'List every repository and development tool mentioned in my transcripts.',
];

export default function AgentScreen({ navigation, route }: Props) {
  const { c } = useTheme();
  const settings = useSettings();
  const [convId, setConvId] = useState<string | null>(route.params?.conversationId ?? null);
  const [input, setInput] = useState(route.params?.prompt ?? '');
  const [historyOpen, setHistoryOpen] = useState(false);
  const { busy, run } = useAction();
  const listRef = useRef<FlatList<Message>>(null);

  const msgs = useQuery(async (repo) => (convId ? repo.listMessages(convId) : []), ['conversations'], [convId]);
  const convs = useQuery((repo) => repo.listConversations(), ['conversations']);
  const titles = useQuery(async (repo) => {
    const ids = [...new Set((msgs.data ?? []).flatMap((m) => m.citations.map((ci) => ci.itemId)))];
    return Object.fromEntries((await repo.itemsByIds(ids)).map((i) => [i.id, i.title || i.url || 'Untitled']));
  }, ['items', 'conversations'], [msgs.data]);

  useEffect(() => {
    if (msgs.data?.length) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
  }, [msgs.data?.length]);

  const send = (text: string) => run(async () => {
    const q = text.trim();
    if (!q) return;
    setInput('');
    const r = await ask(convId, q);
    setConvId(r.conversationId);
  }, 'The assistant failed');

  const runProposal = (p: ActionProposal) => run(async () => {
    if (p.tool !== 'create_report') return;
    const args = p.args as { kind?: string; topic?: string };
    if (!(await confirm('Create report?', `Generate a ${args.kind ?? 'topic'} report${args.topic ? ` about “${args.topic}”` : ''} from your saved items?`, 'Create'))) return;
    const r = await generateReport({ kind: (args.kind === 'weekly' ? 'weekly' : args.kind === 'daily' ? 'daily' : 'topic') as 'daily', topic: args.topic, useAi: settings?.ai.enabled });
    navigation.navigate('ReportDetail', { id: r.id });
  });

  const aiLabel = settings?.ai.enabled ? `Model: ${settings.ai.model}` : 'No AI model — answers quote your saved items';

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.sm }}>
        <View style={{ flex: 1 }}>
          <T v="title" accessibilityRole="header">Ask your library</T>
          <T v="caption" color="textMuted">{aiLabel}</T>
        </View>
        <IconButton icon="time-outline" label="Conversation history" onPress={() => setHistoryOpen(true)} />
        <IconButton icon="create-outline" label="New conversation" onPress={() => setConvId(null)} />
      </View>
      <KeyboardAvoidingView behavior="height" style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          data={msgs.data ?? []}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: space.lg }}
          ListEmptyComponent={
            <View>
              <T color="textMuted" style={{ marginBottom: space.md }}>Answers are grounded in what you saved, with citations. Qivra tells you when your library has no evidence.</T>
              {!settings?.ai.enabled ? <Banner tone="info" title="Works without AI" body="Without a model, Qivra assembles answers from matching items and transcript passages. Add a local Ollama or your own key in Settings → AI models for written answers." action={<Button kind="outline" title="AI models" onPress={() => navigation.navigate('AiProviders')} />} /> : null}
              {SUGGESTIONS.map((s) => <Chip key={s} label={s} onPress={() => void send(s)} />)}
            </View>
          }
          renderItem={({ item: m }) => (
            <View style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'stretch', maxWidth: m.role === 'user' ? '85%' : '100%', marginBottom: space.md }}>
              <View style={{ backgroundColor: m.role === 'user' ? c.primary : c.surface, borderRadius: radius.lg, padding: space.md }}>
                <T color={m.role === 'user' ? c.onPrimary : 'text'} selectable>{m.content}</T>
              </View>
              {m.role === 'assistant' ? (
                <View style={{ marginTop: 6 }}>
                  <T v="caption" color="textFaint">{m.mode === 'model' ? `AI answer · ${m.provider}` : m.mode === 'retrieval_only' ? 'Assembled from your items (no AI model)' : 'No evidence found'}</T>
                  {m.warnings.map((w, i) => <T key={i} v="caption" color="warning">⚠ {w}</T>)}
                  {m.citations.map((ci) => (
                    <Pressable key={ci.sid} onPress={() => navigation.navigate('ItemDetail', { id: ci.itemId })} accessibilityRole="link" accessibilityLabel={`Source ${ci.sid}: ${titles.data?.[ci.itemId] ?? ''}`} style={{ paddingVertical: 6, borderTopWidth: 1, borderColor: c.border }}>
                      <T v="small"><T v="small" color="accent">[{ci.sid}]</T> {titles.data?.[ci.itemId] ?? 'Saved item'}{ci.startMs !== null ? ` @ ${formatTimestamp(ci.startMs)}` : ''}</T>
                      {ci.quote ? <T v="caption" color="textMuted" numberOfLines={2}>{ci.quote}</T> : null}
                    </Pressable>
                  ))}
                  {(m.proposals as ActionProposal[]).map((p, i) => (
                    <Banner key={i} tone="accent" title={`Suggested action: ${p.tool.replace(/_/g, ' ')}`} body={`${p.reason} Nothing happens until you confirm.`} action={p.tool === 'create_report' ? <Button kind="outline" title="Review & create" onPress={() => void runProposal(p)} /> : undefined} />
                  ))}
                </View>
              ) : null}
            </View>
          )}
          ListFooterComponent={busy ? <Loading label="Thinking" /> : null}
        />
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', padding: space.sm, borderTopWidth: 1, borderColor: c.border, backgroundColor: c.bg }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Ask about what you saved…"
            placeholderTextColor={c.textFaint}
            accessibilityLabel="Message"
            multiline
            style={[type.body, { flex: 1, color: c.text, backgroundColor: c.surface, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: 10, maxHeight: 140, minHeight: 48 }]}
          />
          <IconButton icon="arrow-up-circle" size={34} label="Send" onPress={() => void send(input)} color={input.trim() ? c.text : c.textFaint} />
        </View>
      </KeyboardAvoidingView>
      <Sheet visible={historyOpen} onClose={() => setHistoryOpen(false)} title="Conversations">
        {(convs.data ?? []).map((cv) => (
          <View key={cv.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Button kind="text" title={cv.title} onPress={() => { setConvId(cv.id); setHistoryOpen(false); }} style={{ flex: 1, justifyContent: 'flex-start' }} />
            <IconButton icon="trash-outline" label={`Delete ${cv.title}`} onPress={() => void run(async () => { await (await getRepo()).deleteConversation(cv.id); if (convId === cv.id) setConvId(null); await convs.reload(); })} />
          </View>
        ))}
        {!convs.data?.length ? <T color="textMuted">No conversations yet.</T> : null}
      </Sheet>
    </SafeAreaView>
  );
}
