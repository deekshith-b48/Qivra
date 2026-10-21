import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { getRepo } from '../../src/services/db';
import { emit } from '../../src/services/events';
import { ask, dropLastExchange } from '../../src/services/agentService';
import AgentScreen from '../../src/screens/AgentScreen';
import { ThemeProvider } from '../../src/ui/theme';
import { resetTestRepo } from '../helpers/uiSetup';

// Simulate a streaming model: the real screen, with the service emitting deltas like a live answer.
jest.mock('../../src/services/agentService', () => {
  const actual = jest.requireActual('../../src/services/agentService');
  return { ...actual, ask: jest.fn(), askAboutItem: jest.fn() };
});

const nav = () => ({ navigate: jest.fn(), goBack: jest.fn() }) as never;
let release: () => void = () => undefined;

beforeEach(() => {
  resetTestRepo();
  jest.mocked(ask).mockImplementation(async (convId, question, stream = {}) => {
    const repo = await getRepo();
    const id = convId ?? (await repo.createConversation(question));
    await repo.addMessage({ conversationId: id, role: 'user', content: question, mode: null, provider: null, warnings: [], proposals: [], citations: [] });
    stream.onConversation?.(id);
    stream.onStatus?.('writing');
    stream.onDelta?.('Hooks are ');
    await new Promise<void>((r) => { release = r; stream.signal?.addEventListener('abort', () => r()); });
    if (stream.signal?.aborted) {
      await repo.addMessage({ conversationId: id, role: 'assistant', content: 'Hooks are\n\n_(stopped)_', mode: 'model', provider: 'fake', warnings: [], proposals: [], citations: [] });
      emit('conversations');
      return { conversationId: id, result: {} as never };
    }
    stream.onDelta?.('functions [S1].');
    const { item } = await repo.createItem({ sourceType: 'note', title: 'React notes' });
    await repo.addMessage({ conversationId: id, role: 'assistant', content: 'Hooks are functions [S1].', mode: 'model', provider: 'Qivra server · api.groq.com · gpt-oss', warnings: [], proposals: [],
      citations: [{ sid: 'S1', itemId: item.id, transcriptId: null, chunkId: null, startMs: null, quote: 'Hooks are functions.' }] });
    emit('conversations');
    return { conversationId: id, result: {} as never };
  });
});

test('the answer streams in, Send becomes Stop, and the finished answer has a citation pill', async () => {
  render(<ThemeProvider><AgentScreen navigation={nav()} route={{ key: 'a', name: 'Agent' } as never} /></ThemeProvider>);
  fireEvent.press(await screen.findByRole('button', { name: 'Compare my GitHub projects' }));
  expect(await screen.findByText('Hooks are')).toBeTruthy(); // partial text already visible
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  await act(async () => { release(); });
  expect(await screen.findByLabelText('Source 1')).toBeTruthy(); // [S1] rendered as a pill
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sources (1)' })).toBeTruthy();
});

test('Stop keeps the partial answer, marked as stopped', async () => {
  render(<ThemeProvider><AgentScreen navigation={nav()} route={{ key: 'a', name: 'Agent' } as never} /></ThemeProvider>);
  fireEvent.changeText(await screen.findByLabelText('Message'), 'What are hooks?');
  fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Stop' }));
  expect(await screen.findByText('(stopped)')).toBeTruthy();
});

test('regenerate removes the last question and answer before asking again', async () => {
  const repo = await getRepo();
  const id = await repo.createConversation('q');
  await repo.addMessage({ conversationId: id, role: 'user', content: 'first', mode: null, provider: null, warnings: [], proposals: [], citations: [] });
  await repo.addMessage({ conversationId: id, role: 'assistant', content: 'a1', mode: 'model', provider: 'p', warnings: [], proposals: [], citations: [] });
  await repo.addMessage({ conversationId: id, role: 'user', content: 'second', mode: null, provider: null, warnings: [], proposals: [], citations: [] });
  await repo.addMessage({ conversationId: id, role: 'assistant', content: 'a2', mode: 'model', provider: 'p', warnings: [], proposals: [], citations: [] });
  expect(await dropLastExchange(id)).toBe('second');
  await waitFor(async () => expect((await repo.listMessages(id)).map((m) => m.content)).toEqual(['first', 'a1']));
});

test('the Library / General switch changes the placeholder and is sent with the question', async () => {
  render(<ThemeProvider><AgentScreen navigation={nav()} route={{ key: 'a', name: 'Agent' } as never} /></ThemeProvider>);
  const chip = await screen.findByRole('switch');
  expect(chip.props.accessibilityLabel).toMatch(/^Library mode/);
  expect(screen.getByPlaceholderText('Ask about your library…')).toBeTruthy();
  fireEvent.press(chip);
  expect(screen.getByRole('switch').props.accessibilityLabel).toMatch(/^General mode/);
  fireEvent.changeText(screen.getByPlaceholderText('Ask anything…'), 'What is the capital of France?');
  fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(jest.mocked(ask).mock.calls.at(-1)?.[2]).toMatchObject({ mode: 'general' }));
  await act(async () => { release(); });
});
