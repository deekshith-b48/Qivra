/**
 * Building blocks for the Ask screen, styled like modern chat assistants:
 * full-width assistant answers with a small avatar and an action row (Copy,
 * Regenerate, Sources), compact user bubbles, a live streaming reply with a
 * status line and caret, and a composer whose send button turns into Stop.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, TextInput, View } from 'react-native';
import { normalizeCitations } from '../../core/agent/citations';
import { formatTimestamp } from '../../core/transcripts';
import type { Message } from '../../db/types';
import { Sheet, T } from '../components';
import { Markdown } from '../Markdown';
import { radius, space, type, useTheme } from '../theme';

function Avatar() {
  const { c } = useTheme();
  return (
    <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="sparkles" size={15} color={c.accent} />
    </View>
  );
}

function ActionButton({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 8, borderRadius: radius.pill, backgroundColor: pressed ? c.surfaceAlt : 'transparent' })}>
      <Ionicons name={icon} size={16} color={c.textMuted} />
      <T v="caption" color="textMuted">{label}</T>
    </Pressable>
  );
}

export function UserBubble({ text }: { text: string }) {
  const { c } = useTheme();
  return (
    <View style={{ alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: c.surfaceAlt, borderRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: space.lg, paddingVertical: space.sm + 2, marginBottom: space.lg }}>
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
  const [copied, setCopied] = useState(false);
  const label = message.mode === 'model' ? (message.provider ?? 'AI')
    : message.mode === 'general' ? `General answer · not from your library${message.provider ? ` · ${message.provider.split(' · ').pop()}` : ''}`
      : message.mode === 'retrieval_only' ? 'From your saved items (no AI model)' : 'Nothing found in your library';
  return (
    <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.xl }}>
      <Avatar />
      <View style={{ flex: 1 }}>
        <Markdown source={normalizeCitations(message.content)} onCite={onCite} onTime={onTime} />
        {message.warnings.map((w, i) => <T key={i} v="caption" color="warning" style={{ marginTop: 4 }}>⚠ {w}</T>)}
        {footer}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: space.xs, marginLeft: -8 }}>
          <ActionButton icon={copied ? 'checkmark' : 'copy-outline'} label={copied ? 'Copied' : 'Copy'}
            onPress={() => void Clipboard.setStringAsync(normalizeCitations(message.content)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })} />
          {isLast && onRegenerate ? <ActionButton icon="refresh" label="Regenerate" onPress={onRegenerate} /> : null}
          {message.citations.length ? <ActionButton icon="library-outline" label={`Sources (${message.citations.length})`} onPress={onSources} /> : null}
        </View>
        <T v="caption" color="textFaint" style={{ marginTop: 2 }} numberOfLines={1}>{label}</T>
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

export function StreamingMessage({ text, status }: { text: string; status: 'searching' | 'writing' }) {
  return (
    <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.xl }} accessibilityLiveRegion="polite">
      <Avatar />
      <View style={{ flex: 1 }}>
        {text ? <Markdown source={normalizeCitations(text)} /> : (
          <T color="textMuted" style={{ fontStyle: 'italic' }}>{status === 'searching' ? 'Searching your library…' : 'Writing…'}</T>
        )}
        <Caret />
      </View>
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
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 32, paddingHorizontal: 10, marginRight: 4, borderRadius: 16, backgroundColor: general ? `${c.info}22` : c.accentSoft }}>
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
    <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md + bottomInset }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', backgroundColor: c.surface, borderRadius: 28, borderWidth: 1, borderColor: c.border, paddingLeft: space.lg, paddingRight: 6, paddingVertical: 6, shadowColor: '#1A1D23', shadowOpacity: c.cardShadow ? 0.06 : 0, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: c.cardShadow ? 3 : 0 }}>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={c.textFaint}
          accessibilityLabel="Message"
          multiline
          style={[type.body, { flex: 1, color: c.text, maxHeight: 140, minHeight: 40, paddingTop: 8, paddingBottom: 8 }]}
        />
        {mode && onToggleMode && !streaming ? <View style={{ height: 40, justifyContent: 'center' }}><ModeChip mode={mode} onToggle={onToggleMode} /></View> : null}
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
