import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import CaptureScreen from '../../src/screens/CaptureScreen';
import AgentScreen from '../../src/screens/AgentScreen';
import { VoiceSheet } from '../../src/ui/VoiceSheet';
import { ThemeProvider } from '../../src/ui/theme';
import { resetTestRepo } from '../helpers/uiSetup';
import { ensureMicPermission, startRecording, transcribeOnDevice, voiceModeAvailable, deleteRecording } from '../../src/services/voice';
import { voiceModel } from '../../src/core/voiceModels';

jest.mock('../../src/services/voice', () => ({
  ...jest.requireActual('../../src/services/voice'),
  voiceModeAvailable: jest.fn(), ensureMicPermission: jest.fn(), startRecording: jest.fn(),
  transcribeOnDevice: jest.fn(), deleteRecording: jest.fn(async () => undefined),
}));
const availability = { device: true, server: false, preferred: 'device' as const, model: voiceModel('whisper-base') };
const file = { uri: 'file:///private/recording.wav', bytes: 32044, durationMs: 1000 };
const props = { visible: true, purpose: 'dictate' as const, onClose: jest.fn(), onText: jest.fn() };
function show() { return render(<ThemeProvider><VoiceSheet {...props} /></ThemeProvider>); }

beforeEach(() => {
  resetTestRepo(); jest.clearAllMocks();
  jest.mocked(voiceModeAvailable).mockResolvedValue(availability);
  jest.mocked(ensureMicPermission).mockResolvedValue('granted');
  jest.mocked(startRecording).mockResolvedValue({ stop: async () => file, cancel: jest.fn(async () => undefined) });
  jest.mocked(transcribeOnDevice).mockResolvedValue({ text: 'Remember the meeting', segments: [], language: 'en', provider: 'local' });
});

test('setup errors can be retried without reopening the sheet', async () => {
  jest.mocked(voiceModeAvailable).mockRejectedValueOnce(new Error('Storage unavailable'));
  show();
  expect(await screen.findByText('Storage unavailable')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('button', { name: 'Start recording' })).toBeTruthy();
  expect(voiceModeAvailable).toHaveBeenCalledTimes(2);
});

test('native microphone failures are shown with a working retry', async () => {
  jest.mocked(startRecording).mockRejectedValueOnce(new Error('Microphone busy'));
  show();
  fireEvent.press(await screen.findByRole('button', { name: 'Start recording' }));
  expect(await screen.findByText('Microphone busy')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('button', { name: 'Start recording' })).toBeTruthy();
});

test('dictation returns text and deletes temporary audio', async () => {
  show();
  fireEvent.press(await screen.findByRole('button', { name: 'Start recording' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Stop recording' }));
  await waitFor(() => expect(props.onText).toHaveBeenCalledWith('Remember the meeting'));
  expect(deleteRecording).toHaveBeenCalledWith(file.uri);
  expect(props.onClose).toHaveBeenCalled();
});

test('closing during transcription aborts it and ignores its late result', async () => {
  let finish!: (value: never) => void;
  jest.mocked(transcribeOnDevice).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = show();
  fireEvent.press(await screen.findByRole('button', { name: 'Start recording' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Stop recording' }));
  await waitFor(() => expect(transcribeOnDevice).toHaveBeenCalled());
  const signal = jest.mocked(transcribeOnDevice).mock.calls[0][2];
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish({ text: 'Late words', segments: [] } as never); });
  expect(props.onText).not.toHaveBeenCalled();
  expect(deleteRecording).toHaveBeenCalledWith(file.uri);
});


test('note dictation appends to existing writing in the capture screen', async () => {
  render(<ThemeProvider><CaptureScreen navigation={{ navigate: jest.fn() } as never} route={{ key: 'capture', name: 'Capture', params: { mode: 'note' } } as never} /></ThemeProvider>);
  fireEvent.changeText(await screen.findByPlaceholderText('Write or paste anything'), 'Existing idea.');
  fireEvent.press(screen.getByRole('button', { name: 'Dictate note' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Start recording' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Stop recording' }));
  await waitFor(() => expect(screen.getByPlaceholderText('Write or paste anything').props.value).toBe('Existing idea. Remember the meeting'));
});

test('Agent dictation fills the message for review before sending', async () => {
  render(<ThemeProvider><AgentScreen navigation={{ navigate: jest.fn() } as never} route={{ key: 'agent', name: 'Agent' } as never} /></ThemeProvider>);
  fireEvent.press(await screen.findByRole('button', { name: 'Ask by voice' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Start recording' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Stop recording' }));
  await waitFor(() => expect(screen.getByLabelText('Message').props.value).toBe('Remember the meeting'));
  expect(screen.queryByText(/Assembled from your items/)).toBeNull();
});
