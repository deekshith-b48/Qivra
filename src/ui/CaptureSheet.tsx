/**
 * The "+" sheet: every way to save something, one tap away.
 * The clipboard is read only when the user taps "Paste copied link".
 */

import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { requestsFromText } from '../core/share';
import { captureRequest } from '../services/capture';
import { Sheet, T } from './components';
import { radius, space, useTheme } from './theme';

export type CaptureMode = 'link' | 'note' | 'voice' | 'transcript' | 'media';

/** Save the first link on the clipboard. Returns the item id, or a message to show. */
export async function captureCopiedLink(): Promise<{ itemId: string; duplicate: boolean } | { message: string }> {
  const text = (await Clipboard.getStringAsync().catch(() => '')) ?? '';
  const req = requestsFromText(text).find((r) => r.kind === 'url');
  if (!req) return { message: text.trim() ? 'The copied text has no link. Use “Note” to save text.' : 'Nothing is copied. Copy a link first.' };
  const res = await captureRequest(req);
  if (!res.itemId || res.error) return { message: res.error ?? 'Could not save the link.' };
  return { itemId: res.itemId, duplicate: res.duplicate };
}

function Option({ icon, title, subtitle, onPress }: { icon: keyof typeof Ionicons.glyphMap; title: string; subtitle: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title} accessibilityHint={subtitle}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.lg, backgroundColor: pressed ? c.surfaceAlt : c.surface, marginBottom: space.sm })}>
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={22} color={c.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <T v="subtitle">{title}</T>
        <T v="small" color="textMuted">{subtitle}</T>
      </View>
      <Ionicons name="chevron-forward" size={18} color={c.textFaint} />
    </Pressable>
  );
}

export function CaptureSheet({ visible, onClose, onOpenItem, onCapture }: {
  visible: boolean;
  onClose: () => void;
  onOpenItem: (id: string) => void;
  onCapture: (mode: CaptureMode) => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setMessage(null); onClose(); };
  const go = (mode: CaptureMode) => { close(); onCapture(mode); };
  const paste = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await captureCopiedLink();
      if ('message' in r) setMessage(r.message);
      else { close(); onOpenItem(r.itemId); }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet visible={visible} onClose={close} title="Save to Qivra">
      <Option icon="clipboard-outline" title={busy ? 'Saving…' : 'Paste copied link'} subtitle="YouTube, Instagram, X or any web page" onPress={() => void paste()} />
      {message ? <T v="small" color="warning" style={{ marginBottom: space.sm }} accessibilityLiveRegion="polite">{message}</T> : null}
      <Option icon="link-outline" title="Type or paste a link" subtitle="Add a note about why you saved it" onPress={() => go('link')} />
      <Option icon="create-outline" title="Write a note" subtitle="Plain text, searchable offline" onPress={() => go('note')} />
      <Option icon="mic-outline" title="Voice note" subtitle="Recorded and transcribed on this phone" onPress={() => go('voice')} />
      <Option icon="document-attach-outline" title="Import a transcript or file" subtitle="SRT, VTT, TXT, audio or video" onPress={() => go('transcript')} />
      <T v="caption" color="textFaint">Tip: share straight from Instagram, X or YouTube. You can keep scrolling while Qivra transcribes and summarises.</T>
    </Sheet>
  );
}
