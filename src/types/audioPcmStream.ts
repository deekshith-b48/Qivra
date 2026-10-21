/** Types for @fugood/react-native-audio-pcm-stream (its bundled .d.ts declares a different module name). */
export interface PcmRecordOptions {
  sampleRate: number;
  channels: 1 | 2;
  bitsPerSample: 8 | 16;
  /** Android AudioSource; 6 = VOICE_RECOGNITION. */
  audioSource?: number;
  wavFile: string;
  bufferSize?: number;
}
export interface PcmAudioRecord {
  init(options: PcmRecordOptions): void;
  start(): void;
  stop(): Promise<string | null>;
  on(event: 'data', callback: (base64Pcm: string) => void): { remove(): void };
}
