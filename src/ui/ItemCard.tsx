import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Image, Pressable, View } from 'react-native';
import { formatLocal } from '../core/dates';
import { isFailed, isPending, STATUS_LABELS } from '../core/status';
import { SOURCE_LABELS } from '../core/url';
import type { Item } from '../db/types';
import { Chip, T, type IconName } from './components';
import { radius, space, useTheme } from './theme';

export const SOURCE_ICONS: Record<string, IconName> = {
  youtube: 'logo-youtube', instagram: 'logo-instagram', github: 'logo-github', podcast: 'mic-outline', web: 'globe-outline', note: 'document-text-outline', file: 'document-attach-outline', text: 'chatbox-ellipses-outline',
};

export function StatusChip({ status }: { status: Item['status'] }) {
  if (status === 'READY') return null;
  const tone = isFailed(status) ? 'danger' : status === 'NEEDS_INPUT' ? 'warning' : isPending(status) ? 'info' : 'neutral';
  return <Chip label={STATUS_LABELS[status]} tone={tone} />;
}

export function SyncChip({ status }: { status: Item['syncStatus'] }) {
  if (status === 'local_only' || status === 'synced') return null;
  return <Chip label={status === 'pending' ? 'Not synced yet' : status === 'conflicted' ? 'Sync conflict' : 'Sync failed'} tone={status === 'pending' ? 'neutral' : 'danger'} icon="sync-outline" />;
}

export function ItemCard({ item, onPress, onLongPress, selected, timezone, grid }: { item: Item; onPress: () => void; onLongPress?: () => void; selected?: boolean; timezone: string; grid?: boolean }) {
  const { c } = useTheme();
  const title = item.title || item.url || 'Untitled';
  const label = `${SOURCE_LABELS[item.sourceType]}: ${title}. ${STATUS_LABELS[item.status]}.${selected ? ' Selected.' : ''}`;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={onLongPress ? 'Long press to select' : undefined}
      accessibilityState={{ selected: !!selected }}
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
          {item.summary && !grid ? <T v="small" color="textMuted" numberOfLines={2} style={{ marginTop: 2 }}>{item.summary}</T> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 6, gap: 6 }}>
            <T v="caption" color="textFaint">{SOURCE_LABELS[item.sourceType]} · {formatLocal(item.capturedAt, timezone, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</T>
            <StatusChip status={item.status} />
            <SyncChip status={item.syncStatus} />
          </View>
        </View>
        {selected ? <Ionicons name="checkmark-circle" size={22} color={c.accent} /> : null}
      </View>
    </Pressable>
  );
}
