/** Test stand-in for @fugood/react-native-audio-pcm-stream. */
export default { init: jest.fn(), start: jest.fn(), stop: jest.fn(async () => null), on: jest.fn(() => ({ remove: jest.fn() })) };
