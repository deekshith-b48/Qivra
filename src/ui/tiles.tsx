/**
 * Colourful tiles in the style of iOS: an app-icon-like square (white glyph on a
 * system-colour gradient), feature tiles for the Home grid, and stat tiles.
 */

import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type React from 'react';
import { Pressable, View } from 'react-native';
import { elevation, type IconName, T } from './components';
import { radius, space, useTheme } from './theme';
import { soft, type TintName } from './tokens';

/** Lighten a #RRGGBB colour towards white (for the top of the tile gradient). */
function lighten(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (v: number) => Math.round(v + (255 - v) * amount);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function IconTile({ icon, tint, size = 40 }: { icon: IconName; tint: TintName; size?: number }) {
  const { c } = useTheme();
  const color = c.tint[tint];
  return (
    <LinearGradient colors={[lighten(color, 0.18), color]} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
      style={{ width: size, height: size, borderRadius: size * 0.28, alignItems: 'center', justifyContent: 'center' }}>
      {/* Yellow is too light for a white glyph. */}
      <Ionicons name={icon} size={size * 0.55} color={tint === 'yellow' ? '#3A2A00' : '#FFFFFF'} />
    </LinearGradient>
  );
}

/** One cell of the Home "Everything" grid: icon tile, label and an optional count or status dot. */
export function FeatureTile({ icon, tint, label, onPress, count, dot }: {
  icon: IconName; tint: TintName; label: string; onPress: () => void; count?: number; dot?: 'ok' | 'bad';
}) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={count ? `${label}, ${count}` : dot === 'bad' ? `${label}, needs attention` : label}
      style={({ pressed }) => [{ flex: 1, alignItems: 'center', paddingVertical: space.md, paddingHorizontal: 4, borderRadius: radius.lg, backgroundColor: c.surface, opacity: pressed ? 0.75 : 1 }, elevation(c)]}>
      <View>
        <IconTile icon={icon} tint={tint} />
        {count ? (
          <View style={{ position: 'absolute', top: -6, right: -10, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: c.tint.red, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.surface }}>
            <T v="caption" style={{ color: '#FFFFFF', fontSize: 10, fontWeight: '800' }}>{count > 99 ? '99+' : count}</T>
          </View>
        ) : dot ? (
          <View style={{ position: 'absolute', top: -3, right: -3, width: 12, height: 12, borderRadius: 6, backgroundColor: dot === 'ok' ? c.tint.green : c.tint.red, borderWidth: 2, borderColor: c.surface }} />
        ) : null}
      </View>
      <T v="caption" numberOfLines={1} style={{ marginTop: space.sm, fontWeight: '600' }}>{label}</T>
    </Pressable>
  );
}

/** A soft, colourful card with a big number: a stat you can tap. */
export function StatTile({ icon, tint, value, label, onPress, children }: {
  icon: IconName; tint: TintName; value: number | string; label: string; onPress?: () => void; children?: React.ReactNode;
}) {
  const { c } = useTheme();
  const color = c.tint[tint];
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={`${value} ${label}`}
      style={({ pressed }) => ({ flex: 1, padding: space.md, borderRadius: radius.lg, backgroundColor: soft(color), opacity: pressed ? 0.75 : 1 })}>
      <Ionicons name={icon} size={20} color={color} />
      <T v="title" style={{ marginTop: space.xs }}>{value}</T>
      <T v="caption" color="textMuted" numberOfLines={1}>{label}</T>
      {children}
    </Pressable>
  );
}

/** Tints used in turn for lists of chips (topics), so they read as colourful but stay stable per position. */
export const TINT_CYCLE: TintName[] = ['blue', 'purple', 'orange', 'teal', 'pink', 'green', 'indigo'];
