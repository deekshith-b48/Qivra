/**
 * Building blocks for the Ask screen, styled like modern chat assistants:
 * full-width answers under a one-line header (avatar + model), compact icon
 * actions (Copy, Regenerate) and a Sources pill, rounded user bubbles, a live
 * reply with pulsing dots then a caret, and a floating composer whose send
 * button turns into Stop.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, TextInput, View } from 'react-native';
import { normalizeCitations } from '../../core/agent/citations';
import { formatTimestamp } from '../../core/transcripts';
import type { Message } from '../../db/types';
import { elevation, Sheet, T } from '../components';
import { Markdown } from '../Markdown';
import { radius, space, type, useTheme } from '../theme';

/** One line above an answer: the assistant mark and who wrote it. */
function AnswerHeader({ label }: { label: string }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.xs }}>
      <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="sparkles" size={13} color={c.accent} />
      </View>
      <T v="caption" color="textMuted" numberOfLines={1} style={{ flex: 1, fontWeight: '600' }}>{label}</T>
    </View>
  );
}

function IconAction({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}
      style={({ pressed }) => ({ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.surfaceAlt : 'transparent' })}>
      <Ionicons name={icon} size={17} color={c.textMuted} />
    </Pressable>
  );
}

export function UserBubble({ text }: { text: string }) {
  const { c } = useTheme();
  return (
    <View style={{ alignSelf: 'flex-end', maxWidth: '82%', backgroundColor: c.surfaceAlt, borderRadius: 22, borderBottomRightRadius: 8, paddingHorizontal: space.lg, paddingVertical: space.sm + 2, marginBottom: space.lg, marginTop: space.xs }}>
      <T selectable>{text}</T>
    </View>
  );
}

export function AssistantMessage({ message, isLast, onCite, onTime, onSources, onRegenerate, footer }: {
  message: Message;
  isLast: boolean;
  onCite: (sid: string) => void;
  onTime?: (ms: number) => void;
  onSources: () => void;
  onRegenerate?: () => void;
  footer?: React.ReactNode;
}) {
  const { c } = useTheme();
  const [copied, setCopied] = useState(false);
  const label = message.mode === 'model' ? (message.provider ?? 'AI')
    : message.mode === 'general' ? `General answer · not from your library${message.provider ? ` · ${message.provider.split(' · ').pop()}` : ''}`
      : message.mode === 'retrieval_only' ? 'From your saved items (no AI model)' : 'Nothing found in your library';
  return (
    <View style={{ marginBottom: space.xl }}>
      <AnswerHeader label={label} />
      <Markdown source={normalizeCitations(message.content)} onCite={onCite} onTime={onTime} />
      {message.warnings.map((w, i) => <T key={i} v="caption" color="warning" style={{ marginTop: 4 }}>⚠ {w}</T>)}
      {footer}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: space.xs, marginLeft: -6 }}>
        <IconAction icon={copied ? 'checkmark' : 'copy-outline'} label={copied ? 'Copied' : 'Copy'}
          onPress={() => void Clipboard.setStringAsync(normalizeCitations(message.content)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })} />
        {isLast && onRegenerate ? <IconAction icon="refresh" label="Regenerate" onPress={onRegenerate} /> : null}
        {message.citations.length ? (
          <Pressable onPress={onSources} accessibilityRole="button" accessibilityLabel={`Sources (${message.citations.length})`}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 12, marginLeft: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surfaceAlt : 'transparent' })}>
            <Ionicons name="library-outline" size={14} color={c.textMuted} />
            <T v="caption" color="textMuted" style={{ fontWeight: '600' }}>{message.citations.length} {message.citations.length === 1 ? 'source' : 'sources'}</T>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function Caret() {
  const { c } = useTheme();
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 0.15, duration: 450, useNativeDriver: true }),
      Animated.timing(v, { toValue: 1, duration: 450, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.View style={{ width: 8, height: 16, borderRadius: 2, backgroundColor: c.text, opacity: v, marginTop: 4 }} />;
}

/** Three dots pulsing in turn, shown until the first words arrive. */
function ThinkingDots() {
  const { c } = useTheme();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(v, { toValue: 3, duration: 1200, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View style={{ flexDirection: 'row', gap: 5, paddingVertical: 8 }}>
      {[0, 1, 2].map((i) => (
        <Animated.View key={i} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.textMuted,
          opacity: v.interpolate({ inputRange: [i, i + 0.5, i + 1, 3], outputRange: [0.3, 1, 0.3, 0.3], extrapolate: 'clamp' }) }} />
      ))}
    </View>
  );
}

export function StreamingMessage({ text, status }: { text: string; status: 'searching' | 'writing' }) {
  return (
    <View style={{ marginBottom: space.xl }} accessibilityLiveRegion="polite">
      <AnswerHeader label={status === 'searching' ? 'Searching your library…' : 'Writing…'} />
      {text ? (
        <>
          <Markdown source={normalizeCitations(text)} />
          <Caret />
        </>
      ) : <ThinkingDots />}
    </View>
  );
}

export type AskMode = 'library' | 'general';

/** Library ↔ General switch shown inside the composer. */
function ModeChip({ mode, onToggle }: { mode: AskMode; onToggle: () => void }) {
  const { c } = useTheme();
  const general = mode === 'general';
  return (
    <Pressable onPress={onToggle} accessibilityRole="switch" accessibilityState={{ checked: general }}
      accessibilityLabel={general ? 'General mode: chat about anything. Tap for library mode' : 'Library mode: answers from your saved items. Tap for general mode'}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: general ? `${c.info}22` : c.accentSoft }}>
      <Ionicons name={general ? 'globe-outline' : 'library-outline'} size={15} color={general ? c.info : c.accent} />
      <T v="caption" style={{ fontWeight: '700', color: general ? c.info : c.accent }}>{general ? 'General' : 'Library'}</T>
    </Pressable>
  );
}

export function Composer({ value, onChange, onSend, onStop, onVoice, streaming, placeholder, mode, onToggleMode, bottomInset = 0 }: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onVoice: () => void;
  streaming: boolean;
  placeholder: string;
  mode?: AskMode;
  onToggleMode?: () => void;
  /** Space kept free below the composer (the floating tab bar). */
  bottomInset?: number;
}) {
  const { c } = useTheme();
  const canSend = !!value.trim() && !streaming;
  return (
    <View style={{ paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space.sm + bottomInset }}>
      {mode && onToggleMode && !streaming ? <View style={{ flexDirection: 'row', marginBottom: 6, marginLeft: 4 }}><ModeChip mode={mode} onToggle={onToggleMode} /></View> : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', backgroundColor: c.surface, borderRadius: 26, paddingLeft: space.lg, paddingRight: 6, paddingVertical: 5, ...elevation(c, 'float') }}>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={c.textFaint}
          accessibilityLabel="Message"
          multiline
          style={[type.body, { flex: 1, color: c.text, maxHeight: 150, minHeight: 42, paddingTop: 10, paddingBottom: 10 }]}
        />
        {!value.trim() && !streaming ? (
          <Pressable onPress={onVoice} accessibilityRole="button" accessibilityLabel="Ask by voice" hitSlop={6} style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="mic-outline" size={22} color={c.textMuted} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={streaming ? onStop : onSend}
          disabled={!streaming && !canSend}
          accessibilityRole="button"
          accessibilityLabel={streaming ? 'Stop' : 'Send'}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: streaming || canSend ? c.primary : c.surfaceAlt }}
        >
          <Ionicons name={streaming ? 'stop' : 'arrow-up'} size={20} color={streaming || canSend ? c.onPrimary : c.textFaint} />
        </Pressable>
      </View>
    </View>
  );
}

export function SourcesSheet({ message, titles, onClose, onOpen }: {
  message: Message | null;
  titles: Record<string, string>;
  onClose: () => void;
  onOpen: (itemId: string, startMs: number | null) => void;
}) {
  const { c } = useTheme();
  return (
    <Sheet visible={!!message} onClose={onClose} title="Sources">
      {(message?.citations ?? []).map((ci) => (
        <Pressable key={ci.sid} onPress={() => { onClose(); onOpen(ci.itemId, ci.startMs); }} accessibilityRole="link"
          accessibilityLabel={`Source ${ci.sid}: ${titles[ci.itemId] ?? 'Saved item'}`}
          style={({ pressed }) => ({ flexDirection: 'row', gap: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderColor: c.border, opacity: pressed ? 0.7 : 1 })}>
          <View style={{ minWidth: 26, height: 22, borderRadius: 11, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}>
            <T v="caption" color="accent" style={{ fontWeight: '700' }}>{ci.sid.replace(/^\D+/, '')}</T>
          </View>
          <View style={{ flex: 1 }}>
            <T v="small" style={{ fontWeight: '600' }} numberOfLines={2}>{titles[ci.itemId] ?? 'Saved item'}{ci.startMs !== null ? ` · ${formatTimestamp(ci.startMs)}` : ''}</T>
            {ci.quote ? <T v="caption" color="textMuted" numberOfLines={3}>{ci.quote}</T> : null}
          </View>
        </Pressable>
      ))}
    </Sheet>
  );
}
