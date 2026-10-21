/** Two projects: pure logic + SQLite (Node, real node:sqlite with FTS5) and UI (React Native renderer). */
module.exports = {
  projects: [
    {
      displayName: 'logic',
      preset: 'jest-expo/node',
      testMatch: ['<rootDir>/__tests__/core/**/*.test.ts', '<rootDir>/__tests__/db/**/*.test.ts'],
    },
    {
      displayName: 'ui',
      preset: 'jest-expo/android',
      testMatch: ['<rootDir>/__tests__/ui/**/*.test.tsx'],
      setupFiles: ['<rootDir>/__tests__/helpers/uiSetup.ts'],
      moduleNameMapper: {
        '^whisper\\.rn/index$': '<rootDir>/__tests__/helpers/whisperMock.ts',
        '^@fugood/react-native-audio-pcm-stream$': '<rootDir>/__tests__/helpers/pcmMock.ts',
        '^react-native-youtube-iframe$': '<rootDir>/__tests__/helpers/youtubeMock.tsx',
      },
    },
  ],
};
