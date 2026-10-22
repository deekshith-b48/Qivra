import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Image, Pressable, View } from 'react-native';
import { formatLocal } from '../core/dates';
import { isFailed, isPending, STATUS_LABELS } from '../core/status';
import { SOURCE_LABELS } from '../core/url';
import type { Item } from '../db/types';
import { Chip, T, type IconName } from './components';
import { PlatformBadge } from './media';
import { radius, space, useTheme } from './theme';

/** A quick action on one item (swipe or TalkBack's actions menu). */
export interface RowAction {
  name: string;
  label: string;
  run: () => void;
}

/** Props that put actions in TalkBack's actions menu for this card. */
function a11yActions(actions?: RowAction[]) {
  if (!actions?.length) return {};
  return {
    accessibilityActions: actions.map((a) => ({ name: a.name, label: a.label })),
    onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => actions.find((a) => a.name === e.nativeEvent.actionName)?.run(),
  };
}

export const SOURCE_ICONS: Record<string, IconName> = {
  youtube: 'logo-youtube', instagram: 'logo-instagram', x: 'logo-twitter', github: 'logo-github', podcast: 'mic-outline', web: 'globe-outline', note: 'document-text-outline', file: 'document-attach-outline', text: 'chatbox-ellipses-outline',
};

export function StatusChip({ status }: { status: Item['status'] }) {
  if (status === 'READY') return null;
  if (status === 'TRANSCRIBING') return <Chip label="Transcribing…" tone="info" icon="hourglass-outline" />;
  const tone = isFailed(status) ? 'danger' : status === 'NEEDS_INPUT' ? 'warning' : isPending(status) ? 'info' : 'neutral';
  return <Chip label={STATUS_LABELS[status]} tone={tone} />;
}

/** Compact processing state for list rows: processing / ready / needs transcript. */
export function statusDot(status: Item['status']): { label: string; tone: 'info' | 'accent' | 'warning' | 'danger' } {
  if (status === 'READY') return { label: 'Ready', tone: 'accent' };
  if (status === 'NEEDS_INPUT') return { label: 'Needs transcript', tone: 'warning' };
  if (isFailed(status)) return { label: STATUS_LABELS[status], tone: 'danger' };
  return { label: 'Processing', tone: 'info' };
}

export function StatusDot({ status }: { status: Item['status'] }) {
  const { c } = useTheme();
  const { label, tone } = statusDot(status);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c[tone] }} />
      <T v="caption" color="textMuted">{label}</T>
    </View>
  );
}

export function SyncChip({ status }: { status: Item['syncStatus'] }) {
  if (status === 'local_only' || status === 'synced') return null;
  return <Chip label={status === 'pending' ? 'Not synced yet' : status === 'conflicted' ? 'Sync conflict' : 'Sync failed'} tone={status === 'pending' ? 'neutral' : 'danger'} icon="sync-outline" />;
}

export function ItemCard({ item, onPress, onLongPress, selected, timezone, grid, actions }: { item: Item; onPress: () => void; onLongPress?: () => void; selected?: boolean; timezone: string; grid?: boolean; actions?: RowAction[] }) {
  const { c } = useTheme();
  const title = item.title || item.url || 'Untitled';
  // A user-corrected summary wins; otherwise the one-sentence TL;DR.
  const tldr = item.summaryOrigin === 'user' ? item.summary : item.enrichment?.tldr || item.summary;
  const label = `${SOURCE_LABELS[item.sourceType]}: ${title}. ${statusDot(item.status).label}.${selected ? ' Selected.' : ''}`;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={onLongPress ? 'Long press to select' : undefined}
      accessibilityState={{ selected: !!selected }}
      {...a11yActions(actions)}
      android_ripple={{ color: c.surfaceAlt }}
      style={{
        flex: grid ? 1 : undefined, backgroundColor: selected ? c.accentSoft : c.surface, borderRadius: radius.lg, padding: space.md,
        borderWidth: 1, borderColor: selected ? c.accent : c.border, marginBottom: space.sm, marginHorizontal: grid ? space.xs : 0,
      }}
    >
      <View style={{ flexDirection: grid ? 'column' : 'row', gap: space.md }}>
        {item.thumbnailUrl ? (
          <Image source={{ uri: item.thumbnailUrl }} accessibilityIgnoresInvertColors style={{ width: grid ? '100%' : 64, height: grid ? 96 : 64, borderRadius: radius.sm, backgroundColor: c.surfaceAlt }} />
        ) : (
          <View style={{ width: grid ? '100%' : 64, height: grid ? 56 : 64, borderRadius: radius.sm, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name={SOURCE_ICONS[item.sourceType] ?? 'document-outline'} size={24} color={c.textMuted} />
          </View>
        )}
        <View style={{ flex: grid ? undefined : 1 }}>
          <T v="subtitle" numberOfLines={2}>{title}</T>
          {tldr && !grid ? <T v="small" color="textMuted" numberOfLines={1} style={{ marginTop: 2 }}>{tldr}</T> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 6, gap: 6 }}>
            <T v="caption" color="textFaint">{SOURCE_LABELS[item.sourceType]} · {formatLocal(item.capturedAt, timezone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</T>
            <StatusDot status={item.status} />
            <SyncChip status={item.syncStatus} />
          </View>
        </View>
        {selected ? <Ionicons name="checkmark-circle" size={22} color={c.accent} /> : null}
      </View>
    </Pressable>
  );
}

/** Large 16:9 card for videos (YouTube, Instagram reels, X videos). */
export function VideoCard({ item, onPress, onLongPress, selected, timezone, actions }: { item: Item; onPress: () => void; onLongPress?: () => void; selected?: boolean; timezone: string; actions?: RowAction[] }) {
  const { c } = useTheme();
  const title = item.title || item.url || 'Untitled';
  const working = isPending(item.status);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${SOURCE_LABELS[item.sourceType]} video: ${title}. ${STATUS_LABELS[item.status]}.${selected ? ' Selected.' : ''}`}
      accessibilityState={{ selected: !!selected }}
      {...a11yActions(actions)}
      style={{ marginBottom: space.lg, borderRadius: radius.lg, borderWidth: selected ? 2 : 0, borderColor: c.accent, backgroundColor: c.bg }}
    >
      <View style={{ borderRadius: radius.lg, overflow: 'hidden', backgroundColor: c.surfaceAlt, aspectRatio: 16 / 9, justifyContent: 'center', alignItems: 'center' }}>
        {item.thumbnailUrl ? <Image source={{ uri: item.thumbnailUrl }} accessibilityIgnoresInvertColors style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" /> : (
          <Ionicons name={SOURCE_ICONS[item.sourceType] ?? 'videocam-outline'} size={40} color={c.textMuted} />
        )}
        <View style={{ position: 'absolute', top: space.sm, left: space.sm }}><PlatformBadge source={item.sourceType} onMedia /></View>
        {working ? (
          <View style={{ position: 'absolute', bottom: space.sm, left: space.sm, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.scrim, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5 }}>
            <ActivityIndicator size="small" color="#fff" />
            <T v="caption" color="#fff">{STATUS_LABELS[item.status]}</T>
          </View>
        ) : null}
        {selected ? <Ionicons name="checkmark-circle" size={28} color={c.accent} style={{ position: 'absolute', top: space.sm, right: space.sm }} /> : null}
      </View>
      <View style={{ paddingTop: space.sm, paddingHorizontal: 2 }}>
        <T v="subtitle" numberOfLines={2}>{title}</T>
        {item.summary ? <T v="small" color="textMuted" numberOfLines={2} style={{ marginTop: 2 }}>{item.summary}</T> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <T v="caption" color="textFaint">{[item.author, formatLocal(item.capturedAt, timezone, { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ')}</T>
          {!working ? <StatusChip status={item.status} /> : null}
          <SyncChip status={item.syncStatus} />
        </View>
      </View>
    </Pressable>
  );
}

/** Compact 2-column tile for the Videos grid: thumbnail, platform, title and status at a glance. */
export function VideoTile({ item, onPress, onLongPress, selected, actions }: { item: Item; onPress: () => void; onLongPress?: () => void; selected?: boolean; actions?: RowAction[] }) {
  const { c } = useTheme();
  const title = item.title || item.url || 'Untitled';
  const dot = statusDot(item.status);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${SOURCE_LABELS[item.sourceType]} video: ${title}. ${dot.label}.${selected ? ' Selected.' : ''}`}
      accessibilityHint={onLongPress ? 'Long press to select' : undefined}
      accessibilityState={{ selected: !!selected }}
      {...a11yActions(actions)}
      style={({ pressed }) => ({ flex: 1, maxWidth: '48%', marginHorizontal: space.xs, marginBottom: space.md, opacity: pressed ? 0.85 : 1 })}
    >
      <View style={{ borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.surfaceAlt, aspectRatio: 16 / 9, alignItems: 'center', justifyContent: 'center', borderWidth: selected ? 2 : 0, borderColor: c.accent }}>
        {item.thumbnailUrl ? <Image source={{ uri: item.thumbnailUrl }} accessibilityIgnoresInvertColors style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" /> : (
          <Ionicons name={SOURCE_ICONS[item.sourceType] ?? 'videocam-outline'} size={28} color={c.textMuted} />
        )}
        <View style={{ position: 'absolute', top: 6, left: 6 }}><PlatformBadge source={item.sourceType} onMedia /></View>
        {item.status !== 'READY' ? (
          <View style={{ position: 'absolute', bottom: 6, left: 6, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: c.scrim, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 }}>
            {isPending(item.status) ? <ActivityIndicator size="small" color="#fff" /> : <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c[dot.tone] }} />}
            <T v="caption" color="#fff">{dot.label}</T>
          </View>
        ) : null}
        {selected ? <Ionicons name="checkmark-circle" size={24} color={c.accent} style={{ position: 'absolute', top: 6, right: 6 }} /> : null}
      </View>
      <T v="small" numberOfLines={2} style={{ marginTop: 6, fontWeight: '600' }}>{title}</T>
    </Pressable>
  );
}
