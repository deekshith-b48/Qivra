/** Test stand-in for react-native-youtube-iframe (the real one needs the native WebView). */
import React, { forwardRef, useImperativeHandle } from 'react';
import { Text } from 'react-native';

export const seekTo = jest.fn();
export const getCurrentTime = jest.fn(async () => 0);

const YoutubePlayer = forwardRef<unknown, { videoId: string; play?: boolean; onReady?: () => void }>(function YoutubePlayer({ videoId, play, onReady }, ref) {
  useImperativeHandle(ref, () => ({ seekTo, getCurrentTime }));
  React.useEffect(() => { onReady?.(); }, [onReady]);
  return <Text testID="youtube-player">{`player:${videoId}:${play ? 'playing' : 'paused'}`}</Text>;
});

export default YoutubePlayer;
