import React, { useEffect, useState } from 'react';
import { Alert, Linking, View } from 'react-native';
import { createOpenAICompatProvider, ProviderError } from '../core/ai/provider';
import { checkServerUrl, isPrivateHost } from '../core/net';
import type { RootProps } from '../navigation/types';
import { deleteSecret, getSecret, SECRET_KEYS, setSecret } from '../services/secure';
import { GEMINI_EMBED } from '../services/ai';
import { ensureEmbeddings } from '../services/semantic';
import { updateSettings } from '../services/settings';
import { Banner, Button, Card, Chip, Field, Header, Screen, Section, T, ToggleRow } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { space } from '../ui/theme';
import { useAiInfo, useSettings } from '../ui/useSettings';

// Model ids checked October 2026 (Groq against its live /models list). Hosted presets need the user's own key.
const PRESETS: { label: string; baseUrl: string; model: string; embeddingModel: string; note: string }[] = [
  { label: 'Groq · gpt-oss (your key)', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', embeddingModel: '', note: 'Hosted open-weight model, very fast, free tier. Groq has no embedding models, so keyword search is used. Content leaves your network.' },
  { label: 'Mistral (your key)', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', embeddingModel: 'mistral-embed', note: 'Hosted open-weight model with embeddings (semantic search). Free “Experiment” plan. Content leaves your network.' },
  { label: 'Gemini (your key)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', embeddingModel: 'gemini-embedding-001', note: 'Hosted (not open source), generous free tier, includes embeddings. Content leaves your network.' },
  { label: 'OpenRouter (your key)', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-120b:free', embeddingModel: '', note: 'One key for many open models; “:free” models are rate-limited. Content leaves your network.' },
  { label: 'Ollama on my laptop', baseUrl: 'http://192.168.1.10:11434/v1', model: 'qwen2.5:3b', embeddingModel: 'nomic-embed-text', note: 'Free and local. Replace the IP with your laptop’s; run `OLLAMA_HOST=0.0.0.0 ollama serve`.' },
  { label: 'LM Studio', baseUrl: 'http://192.168.1.10:1234/v1', model: 'local-model', embeddingModel: '', note: 'Free and local. Enable “Serve on local network”.' },
];

export default function AiProvidersScreen({ navigation }: RootProps<'AiProviders'>) {
  const s = useSettings();
  const ai = useAiInfo();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const { busy, run } = useAction();
  const usage = useQuery(async (repo) => repo.usageSince(new Date(Date.now() - 30 * 86400_000).toISOString()), ['conversations', 'items', 'reports']);

  useEffect(() => {
    if (!s) return;
    setBaseUrl(s.ai.baseUrl);
    setModel(s.ai.model);
    setEmbeddingModel(s.ai.embeddingModel);
    void getSecret(SECRET_KEYS.aiApiKey).then((k) => setHasKey(!!k));
  }, [s?.ai.baseUrl, s?.ai.model, s?.ai.embeddingModel]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = baseUrl ? checkServerUrl(baseUrl) : null;
  const external = check?.ok ? !isPrivateHost(check.url.hostname) : false;

  const save = () => run(async () => {
    if (!check?.ok) return Alert.alert('Invalid endpoint', check ? check.message : 'Enter the API base URL.');
    if (!model.trim()) return Alert.alert('Model required', 'Enter the model name.');
    let consent = s?.ai.externalConsent ?? false;
    if (external && !consent) {
      consent = await confirm('Send content to an external provider?', `When you ask questions, enrich items or generate AI summaries, the relevant saved text (titles, notes, transcript passages) is sent to ${check.url.hostname}. Its own privacy policy applies. Usage may be billed to your key.`, 'I understand');
      if (!consent) return;
    }
    if (key.trim()) await setSecret(SECRET_KEYS.aiApiKey, key.trim());
    setKey('');
    setHasKey(!!(await getSecret(SECRET_KEYS.aiApiKey)));
    await updateSettings({ ai: { enabled: true, baseUrl: baseUrl.trim(), model: model.trim(), embeddingModel: embeddingModel.trim(), externalConsent: external ? consent : false, autoEnrich: s?.ai.autoEnrich ?? false } });
  }, 'Could not save');

  const testIt = () => run(async () => {
    setTest(null);
    try {
      const p = createOpenAICompatProvider({ baseUrl: baseUrl.trim(), model: model.trim(), apiKey: key.trim() || (await getSecret(SECRET_KEYS.aiApiKey)), timeoutMs: 30_000 });
      if (external && !(await confirm('Send a test message?', `A short test prompt (no saved content) is sent to ${check?.ok ? check.url.hostname : 'the provider'}.`, 'Send'))) return;
      const r = await p.chat([{ role: 'user', content: 'Reply with the single word: ok' }], { maxTokens: 5 });
      setTest({ ok: true, msg: `Responded via ${r.model}: “${r.content.trim().slice(0, 40)}”` });
    } catch (e) {
      setTest({ ok: false, msg: (e as Error).message });
    }
  });

  return (
    <Screen>
      <Header title="AI models" subtitle="Optional. Without a model Qivra still extracts, searches and reports." onBack={() => navigation.goBack()} />
      <Card>
        <T v="subtitle">Status</T>
        <T color="textMuted">{s?.ai.enabled
          ? `Using ${s.ai.model} at ${s.ai.baseUrl}${s.ai.externalConsent ? ' (external, consent given)' : ''}`
          : 'No model configured. Choose the Groq preset and paste your free key from console.groq.com/keys. Without it, answers quote your saved items and summaries are extractive.'}</T>
        {usage.data ? <T v="small" color="textMuted" style={{ marginTop: 4 }}>Last 30 days: {usage.data.calls} model call(s), {usage.data.promptTokens + usage.data.completionTokens} tokens reported by the provider. Cost depends on your provider’s pricing.</T> : null}
      </Card>
      <Section title="Presets">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {PRESETS.map((p) => <Chip key={p.label} label={p.label} onPress={() => { setBaseUrl(p.baseUrl); setModel(p.model); setEmbeddingModel(p.embeddingModel); Alert.alert(p.label, p.note); }} />)}
        </View>
      </Section>
      <Section title="OpenAI-compatible endpoint">
        <Field label="API base URL" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="http://192.168.1.10:11434/v1" error={check && !check.ok ? check.message : null} />
        <Field label="Chat model" value={model} onChangeText={setModel} autoCapitalize="none" autoCorrect={false} />
        <Field label="Embedding model (optional, enables semantic search)" value={embeddingModel} onChangeText={setEmbeddingModel} autoCapitalize="none" autoCorrect={false} placeholder="nomic-embed-text" />
        <Field label={hasKey ? 'API key (saved — enter a new one to replace)' : 'API key (if the provider needs one)'} value={key} onChangeText={setKey} secureTextEntry autoCapitalize="none" autoCorrect={false} help="Stored in Android Keystore-backed storage; never synced, exported or shown again." />
        {external ? <Banner tone="warning" title="External provider" body="Saved content you use with AI will leave your network. Qivra asks for consent before enabling this." /> : check?.ok ? <Banner tone="accent" title="Local network provider" body="Requests stay on your network." /> : null}
        {test ? <Banner tone={test.ok ? 'accent' : 'danger'} title={test.ok ? 'Connection works' : 'Test failed'} body={test.msg} /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          <Button title="Save" onPress={() => void save()} loading={busy} />
          <Button kind="outline" title="Test" onPress={() => void testIt()} disabled={!check?.ok || !model} />
        </View>
      </Section>
      {s?.ai.enabled ? (
        <Section title="Behaviour">
          <ToggleRow title="Enrich new items with AI automatically" subtitle="Otherwise use “Enrich with AI” on an item." value={s.ai.autoEnrich} onChange={(v) => void updateSettings({ ai: { ...s.ai, autoEnrich: v } })} />
          <Button kind="danger" title="Remove AI configuration" onPress={() => void run(async () => {
            await deleteSecret(SECRET_KEYS.aiApiKey);
            setHasKey(false);
            await updateSettings({ ai: { enabled: false, baseUrl: '', model: '', embeddingModel: '', externalConsent: false, autoEnrich: false } });
          })} style={{ marginTop: space.md }} />
        </Section>
      ) : null}
      <MeaningSearchSection />
    </Screen>
  );
}

/** Optional free Gemini key: real search by meaning and Related items without a server. */
function MeaningSearchSection() {
  const s = useSettings();
  const { run, busy } = useAction();
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!s) return null;
  const on = !!s.ai.embed?.enabled;
  const verify = () => run(async () => {
    setMsg(null);
    const p = createOpenAICompatProvider({ baseUrl: GEMINI_EMBED.baseUrl, model: GEMINI_EMBED.model, apiKey: key.trim(), embeddingModel: GEMINI_EMBED.model, timeoutMs: 30_000 });
    try {
      const [v] = await p.embed!(['test']);
      if (!v?.length) throw new Error('No vector returned');
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ProviderError && e.code === 'AUTH' ? 'Google rejected this key. Copy it again from aistudio.google.com/apikey.' : 'Could not get a test result from Google. Check the key and your connection.' });
      return;
    }
    await setSecret(SECRET_KEYS.embedApiKey, key.trim());
    setKey('');
    await updateSettings({ ai: { ...s.ai, embed: { enabled: true, ...GEMINI_EMBED } } });
    await ensureEmbeddings();
    setMsg({ ok: true, text: 'Search by meaning is on. Your library is being indexed in the background.' });
  });
  return (
    <Section title="Search by meaning (optional)">
      <T v="small" color="textMuted">
        {on
          ? 'On, with your Gemini key. Library search finds items about the same thing in any language, and items show Related.'
          : 'With your Groq key, Library search already adds related results by rewriting your query. For true search by meaning and Related items, add a free Gemini key. Your saved text is sent to Google to make search vectors.'}
      </T>
      {msg ? <Banner tone={msg.ok ? 'accent' : 'danger'} title={msg.ok ? 'Key works' : 'Key not saved'} body={msg.text} /> : null}
      {on ? (
        <Button kind="outline" title="Remove Gemini key" style={{ marginTop: space.sm }} onPress={() => void run(async () => {
          await deleteSecret(SECRET_KEYS.embedApiKey);
          await updateSettings({ ai: { ...s.ai, embed: undefined } });
          setMsg(null);
        })} />
      ) : (
        <>
          <Button kind="text" title="Get a free Gemini key" icon="open-outline" onPress={() => void Linking.openURL('https://aistudio.google.com/apikey')} />
          <Field label="Your Gemini API key" value={key} onChangeText={setKey} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="AIza…" />
          <Button title="Verify & save" loading={busy} disabled={!key.trim()} onPress={() => void verify()} />
        </>
      )}
    </Section>
  );
}
