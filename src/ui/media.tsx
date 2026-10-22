/** Media-page building blocks: segmented tabs, highlighted text, progress steps, platform badge. */

import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { splitHighlights } from '../core/highlights';
import { SOURCE_LABELS, type SourceType } from '../core/url';
import type { IconName } from './components';
import { fonts, radius, space, type, useTheme } from './theme';

export const PLATFORM_ICONS: Record<string, IconName> = {
  youtube: 'logo-youtube', instagram: 'logo-instagram', x: 'logo-twitter', github: 'logo-github', podcast: 'mic-outline',
  web: 'globe-outline', note: 'document-text-outline', file: 'document-attach-outline', text: 'chatbox-ellipses-outline',
};

export function PlatformBadge({ source, onMedia }: { source: SourceType; onMedia?: boolean }) {
  const { c } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={SOURCE_LABELS[source]}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: onMedia ? c.scrim : c.surfaceAlt }}
    >
      <Ionicons name={PLATFORM_ICONS[source] ?? 'link-outline'} size={14} color={onMedia ? c.onMedia : c.text} />
      <Text style={[type.caption, { color: onMedia ? c.onMedia : c.text }]}>{SOURCE_LABELS[source]}</Text>
    </View>
  );
}

export function Segmented<K extends string>({ options, value, onChange }: { options: { key: K; label: string; count?: number }[]; value: K; onChange: (k: K) => void }) {
  const { c } = useTheme();
  return (
    <View accessibilityRole="tablist" style={[{ flexDirection: 'row', backgroundColor: c.surface, borderRadius: radius.pill, padding: 4 }, c.cardShadow ? { shadowColor: '#1A1D23', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 } : { borderWidth: 1, borderColor: c.border }]}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${o.label}${o.count !== undefined ? `, ${o.count}` : ''}`}
            style={{ flex: 1, minHeight: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.primary : 'transparent', flexDirection: 'row', gap: 6 }}
          >
            <Text style={[type.subtitle, { fontSize: 14, color: on ? c.onPrimary : c.textMuted }]}>{o.label}</Text>
            {o.count !== undefined ? <Text style={[type.caption, { color: on ? c.onPrimary : c.textFaint, opacity: on ? 0.75 : 1 }]}>{o.count}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Text with keyword occurrences highlighted (light-green mark, bold). */
export function HighlightedText({ text, terms, style, numberOfLines, selectable }: { text: string; terms: string[]; style?: object; numberOfLines?: number; selectable?: boolean }) {
  const { c } = useTheme();
  const spans = splitHighlights(text, terms);
  return (
    <Text style={[type.body, { color: c.text }, style]} numberOfLines={numberOfLines} selectable={selectable}>
      {spans.map((s, i) =>
        s.hit ? (
          <Text key={i} style={{ backgroundColor: c.highlight, color: c.onHighlight, fontFamily: fonts.bold }}>{s.text}</Text>
        ) : (
          <Text key={i}>{s.text}</Text>
        ),
      )}
    </Text>
  );
}

export type StepState = 'done' | 'active' | 'todo' | 'blocked' | 'skipped';

export function ProgressSteps({ steps }: { steps: { label: string; state: StepState }[] }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginVertical: space.md }} accessibilityRole="progressbar" accessibilityLabel={steps.map((s) => `${s.label}: ${s.state}`).join(', ')}>
      {steps.map((s, i) => {
        const color = s.state === 'done' ? c.accent : s.state === 'active' ? c.text : s.state === 'blocked' ? c.warning : c.textFaint;
        return (
          <View key={s.label} style={{ flex: 1, alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%' }}>
              <View style={{ flex: 1, height: 2, backgroundColor: i === 0 ? 'transparent' : steps[i - 1].state === 'done' ? c.accent : c.border }} />
              <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: color, backgroundColor: s.state === 'done' ? c.accentSoft : c.bg }}>
                {s.state === 'active' ? <ActivityIndicator size="small" color={c.text} /> : (
                  <Ionicons name={s.state === 'done' ? 'checkmark' : s.state === 'blocked' ? 'alert' : s.state === 'skipped' ? 'remove' : 'ellipse-outline'} size={14} color={color} />
                )}
              </View>
              <View style={{ flex: 1, height: 2, backgroundColor: i === steps.length - 1 ? 'transparent' : s.state === 'done' ? c.accent : c.border }} />
            </View>
            <Text style={[type.caption, { color: s.state === 'todo' ? c.textFaint : c.text, marginTop: 4, textAlign: 'center' }]}>{s.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function TimestampPill({ label, onPress }: { label: string; onPress?: () => void }) {
  const { c } = useTheme();
  const body = (
    <View style={{ backgroundColor: c.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3, minWidth: 52, alignItems: 'center' }}>
      <Text style={[type.mono, { color: c.text, fontSize: 12 }]}>{label}</Text>
    </View>
  );
  if (!onPress) return body;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Play from ${label}`} hitSlop={8}>{body}</Pressable>;
}

