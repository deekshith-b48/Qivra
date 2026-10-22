/**
 * Item-page hero for YouTube: the thumbnail until you press play, then the
 * embedded player (YouTube's own iframe player in a WebView, nothing is
 * downloaded). Key moments and transcript timestamps seek it in place, and
 * the current playback time is reported so the transcript can follow along.
 */

import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Image, Linking, Pressable, useWindowDimensions, View } from 'react-native';
import YoutubePlayer, { type YoutubeIframeRef } from 'react-native-youtube-iframe';
import { Button, T } from './components';
import { radius, space, useTheme } from './theme';

export interface YouTubeHeroHandle {
  /** Start (or move) playback at this time. */
  seek(ms: number): void;
}

interface Props {
  videoId: string;
  thumbnailUrl: string | null;
  badge?: React.ReactNode;
  /** Called about once a second while playing. */
  onTime?: (ms: number) => void;
}

export const YouTubeHero = forwardRef<YouTubeHeroHandle, Props>(function YouTubeHero({ videoId, thumbnailUrl, badge, onTime }, ref) {
  const { c } = useTheme();
  const player = useRef<YoutubeIframeRef>(null);
  const pendingSeek = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);

  useImperativeHandle(ref, () => ({
    seek(ms: number) {
      const sec = Math.max(0, Math.floor(ms / 1000));
      if (ready && player.current) {
        player.current.seekTo(sec, true);
        setPlaying(true);
      } else {
        pendingSeek.current = sec;
        setActive(true);
        setPlaying(true);
      }
    },
  }), [ready]);

  // Follow along: poll the player time while it plays.
  useEffect(() => {
    if (!playing || !ready || !onTime) return;
    const t = setInterval(() => {
      void player.current?.getCurrentTime().then((s) => onTime(Math.round(s * 1000))).catch(() => undefined);
    }, 1000);
    return () => clearInterval(t);
  }, [playing, ready, onTime]);

  // Before the first layout pass, assume the usual page width so the player can mount at once.
  const win = useWindowDimensions();
  const w = width || Math.max(200, win.width - 2 * space.lg);
  const height = Math.round((w * 9) / 16);
  const openApp = () => void Linking.openURL(`https://www.youtube.com/watch?v=${videoId}`);

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ borderRadius: radius.lg, overflow: 'hidden', backgroundColor: c.scrim, aspectRatio: 16 / 9 }}>
      {active && !failed ? (
        <YoutubePlayer
          ref={player}
          height={height}
          width={w}
          videoId={videoId}
          play={playing}
          initialPlayerParams={{ start: pendingSeek.current ?? undefined, preventFullScreen: false, rel: false }}
          onReady={() => {
            setReady(true);
            if (pendingSeek.current !== null) {
              player.current?.seekTo(pendingSeek.current, true);
              pendingSeek.current = null;
            }
          }}
          onChangeState={(s: string) => {
            if (s === 'playing') setPlaying(true);
            else if (s === 'paused' || s === 'ended') setPlaying(false);
          }}
          onError={() => setFailed(true)}
          webViewProps={{ allowsInlineMediaPlayback: true, mediaPlaybackRequiresUserAction: false }}
        />
      ) : failed ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg, backgroundColor: c.surfaceAlt }}>
          <T color="textMuted" style={{ textAlign: 'center' }}>This video can't play inside Qivra (offline, or embedding is disabled).</T>
          <Button kind="outline" title="Open in YouTube" icon="logo-youtube" onPress={openApp} style={{ marginTop: space.sm }} />
        </View>
      ) : (
        <Pressable onPress={() => { setActive(true); setPlaying(true); }} accessibilityRole="button" accessibilityLabel="Play video here" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {thumbnailUrl ? <Image source={{ uri: thumbnailUrl }} accessibilityIgnoresInvertColors style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" /> : null}
          <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: c.scrim, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="play" size={32} color="#fff" style={{ marginLeft: 4 }} />
          </View>
        </Pressable>
      )}
      {badge && !active ? <View style={{ position: 'absolute', top: space.sm, left: space.sm }}>{badge}</View> : null}
    </View>
  );
});
