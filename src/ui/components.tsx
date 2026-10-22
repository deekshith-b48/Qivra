/** Qivra UI kit: small, accessible building blocks on top of the design tokens (./tokens.ts). */

import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View,
  type StyleProp, type TextInputProps, type TextProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { familyFor, fonts, radius, shadow, space, type, useTheme, type Palette } from './theme';

export type IconName = keyof typeof Ionicons.glyphMap;

type TextVariant = keyof typeof type;

/** Text in the theme font. A fontWeight in `style` picks the matching font family (real bold, not faux bold). */
export function T({ v = 'body', color, style, children, ...rest }: Omit<TextProps, 'style'> & { v?: TextVariant; color?: keyof Palette | string; style?: StyleProp<TextStyle>; children: React.ReactNode }) {
  const { c } = useTheme();
  const col = color ? ((c as unknown as Record<string, string>)[color] ?? color) : c.text;
  const flat = StyleSheet.flatten(style) as TextStyle | undefined;
  const weight = flat?.fontWeight ? { fontFamily: familyFor(flat.fontWeight), fontWeight: undefined } : null;
  return <Text style={[type[v], { color: col }, style, weight]} {...rest}>{children}</Text>;
}

/** Card elevation for the current scheme: soft shadow in light mode, hairline border in dark mode. */
export function elevation(c: Palette, kind: 'card' | 'float' | 'button' = 'card'): ViewStyle {
  return c.cardShadow ? { ...shadow[kind], borderWidth: 0 } : { borderWidth: 1, borderColor: c.border };
}

/** The screen background: a soft vertical gradient (light) or a deep-red glow on black (dark). */
export function Backdrop() {
  const { c } = useTheme();
  // Keyed by scheme: a native gradient view does not reliably repaint when its colours change in place.
  return <LinearGradient key={c.scheme} pointerEvents="none" colors={c.bgGradient} locations={[0, 0.32, 1]} style={StyleSheet.absoluteFill} />;
}

export function Screen({ children, scroll = true, padded = true, edges = ['top'] as ('top' | 'bottom')[], scrollRef, bottomInset = 0 }: {
  children: React.ReactNode; scroll?: boolean; padded?: boolean; edges?: ('top' | 'bottom')[]; scrollRef?: React.Ref<ScrollView>;
  /** Extra space at the bottom (e.g. for the floating tab bar). */
  bottomInset?: number;
}) {
  const { c } = useTheme();
  const inner = padded ? { paddingHorizontal: space.lg, paddingBottom: space.xxl + bottomInset } : { paddingBottom: bottomInset };
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: c.bg }}>
      <Backdrop />
      {scroll ? <ScrollView ref={scrollRef} contentContainerStyle={inner} keyboardShouldPersistTaps="handled">{children}</ScrollView> : <View style={[{ flex: 1 }, inner]}>{children}</View>}
    </SafeAreaView>
  );
}

/** Round icon button on a card surface (header actions, back). */
export function CircleButton({ icon, label, onPress, color, size = 20 }: { icon: IconName; label: string; onPress: () => void; color?: string; size?: number }) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}
      style={({ pressed }) => [styles.circle, { backgroundColor: c.surface }, elevation(c, 'button'), pressed && { opacity: 0.75 }]}>
      <Ionicons name={icon} size={size} color={color ?? c.text} />
    </Pressable>
  );
}

export function Header({ title, subtitle, onBack, actions }: { title: string; subtitle?: string; onBack?: () => void; actions?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      {onBack ? <View style={{ flexDirection: 'row', marginBottom: space.md }}>
        <CircleButton icon="arrow-back" label="Back" onPress={onBack} />
        <View style={{ flex: 1 }} />
        {actions ? <View style={{ flexDirection: 'row', gap: space.sm }}>{actions}</View> : null}
      </View> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <T v="display" accessibilityRole="header" numberOfLines={2}>{title}</T>
          {subtitle ? <T v="small" color="textMuted" numberOfLines={2} style={{ marginTop: 2 }}>{subtitle}</T> : null}
        </View>
        {!onBack && actions ? <View style={{ flexDirection: 'row', gap: space.sm }}>{actions}</View> : null}
      </View>
    </View>
  );
}

export function Wordmark({ size = 22 }: { size?: number }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }} accessible accessibilityLabel="Qivra">
      <View style={{ width: size * 0.9, height: size * 0.9, borderRadius: size, borderWidth: size * 0.16, borderColor: c.text, marginRight: 8, alignItems: 'flex-end', justifyContent: 'flex-end' }}>
        <LinearGradient key={c.scheme} colors={c.fabGradient} style={{ width: size * 0.32, height: size * 0.32, borderRadius: 3, transform: [{ translateX: size * 0.12 }, { translateY: size * 0.12 }] }} />
      </View>
      <Text style={{ fontSize: size, fontFamily: fonts.extrabold, letterSpacing: -0.8, color: c.text }}>qivra</Text>
    </View>
  );
}

export function Card({ children, style, onPress, label }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; label?: string }) {
  const { c } = useTheme();
  const base = [{ backgroundColor: c.surface, borderRadius: radius.card, padding: space.lg }, elevation(c), style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [base, pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] }]}>
      {children}
    </Pressable>
  );
}

type ButtonKind = 'filled' | 'tonal' | 'outline' | 'text' | 'danger';
export function Button({ title, onPress, kind = 'filled', icon, disabled, loading, style, accessibilityHint }: { title: string; onPress: () => void; kind?: ButtonKind; icon?: IconName; disabled?: boolean; loading?: boolean; style?: StyleProp<ViewStyle>; accessibilityHint?: string }) {
  const { c } = useTheme();
  const bg = { filled: c.primary, tonal: c.surfaceAlt, outline: c.surface, text: 'transparent', danger: c.dangerSoft }[kind];
  const fg = { filled: c.onPrimary, tonal: c.text, outline: c.text, text: c.text, danger: c.danger }[kind];
  const off = disabled || loading;
  const content = (
    <>
      {loading ? <ActivityIndicator color={fg} size="small" /> : icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
      <Text style={[type.subtitle, { color: fg, fontSize: 15 }]}>{title}</Text>
    </>
  );
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: kind === 'outline' ? c.border : 'transparent', opacity: off ? 0.5 : pressed ? 0.85 : 1 },
        kind === 'outline' && c.cardShadow ? { ...shadow.button, borderWidth: 0 } : null,
        style,
      ]}
    >
      {kind === 'filled' ? (
        <LinearGradient key={c.scheme} colors={c.primaryGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, { borderRadius: radius.pill }]} />
      ) : null}
      {content}
    </Pressable>
  );
}

export function IconButton({ icon, label, onPress, color, size = 22 }: { icon: IconName; label: string; onPress: () => void; color?: string; size?: number }) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={4} style={({ pressed }) => [styles.iconBtn, pressed && { backgroundColor: c.surfaceAlt }]}>
      <Ionicons name={icon} size={size} color={color ?? c.text} />
    </Pressable>
  );
}

export function Chip({ label, selected, onPress, icon, tone = 'neutral' }: { label: string; selected?: boolean; onPress?: () => void; icon?: IconName; tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'info' }) {
  const { c } = useTheme();
  const tones = {
    neutral: [c.surface, c.text], accent: [c.accentSoft, c.onAccentSoft], warning: [c.warningSoft, c.warning], danger: [c.dangerSoft, c.danger], info: [c.infoSoft, c.info],
  } as const;
  const [bg, fg] = selected ? [c.primary, c.onPrimary] : tones[tone];
  const body = (
    <View style={[styles.chip, { backgroundColor: bg }, tone === 'neutral' && !selected ? (c.cardShadow ? { borderWidth: 1, borderColor: c.border } : { borderWidth: 1, borderColor: c.border }) : null]}>
      {selected ? <Ionicons name="checkmark" size={14} color={fg} /> : icon ? <Ionicons name={icon} size={14} color={fg} /> : null}
      <Text style={[type.caption, { color: fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!selected }} style={styles.chipTouch}>
      {body}
    </Pressable>
  );
}

export function Field({ label, help, error, style, ...props }: TextInputProps & { label: string; help?: string; error?: string | null }) {
  const { c } = useTheme();
  return (
    <View style={[{ marginBottom: space.md }, style as StyleProp<ViewStyle>]}>
      <T v="caption" color="textMuted" style={{ marginBottom: 6 }}>{label}</T>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={c.textFaint}
        {...props}
        style={[type.body, { color: c.text, backgroundColor: c.surface, borderColor: error ? c.danger : c.border, borderWidth: 1, borderRadius: radius.input, paddingHorizontal: space.lg, paddingVertical: 12, minHeight: 52, textAlignVertical: props.multiline ? 'top' : 'center' }]}
      />
      {error ? <T v="small" color="danger" style={{ marginTop: 4 }}>{error}</T> : help ? <T v="small" color="textFaint" style={{ marginTop: 4 }}>{help}</T> : null}
    </View>
  );
}

/** "See all ●" style link for section headers. */
export function SectionLink({ label = 'See all', onPress }: { label?: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={label} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <T v="small" style={{ fontWeight: '600' }}>{label}</T>
      <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="chevron-forward" size={10} color={c.onPrimary} />
      </View>
    </Pressable>
  );
}

export function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: space.xl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
        <T v="subtitle" style={{ flex: 1, fontSize: 17 }} accessibilityRole="header">{title}</T>
        {action}
      </View>
      {children}
    </View>
  );
}

/** Three (or more) numbers in one card, separated by thin dividers. */
export function StatStrip({ items }: { items: { value: number | string; label: string; onPress?: () => void }[] }) {
  const { c } = useTheme();
  return (
    <View style={[{ flexDirection: 'row', backgroundColor: c.surface, borderRadius: radius.card, paddingVertical: space.lg }, elevation(c)]}>
      {items.map((it, i) => (
        <Pressable key={it.label} onPress={it.onPress} disabled={!it.onPress} accessibilityRole={it.onPress ? 'button' : undefined} accessibilityLabel={`${it.value} ${it.label}`}
          style={{ flex: 1, alignItems: 'center', borderLeftWidth: i ? StyleSheet.hairlineWidth : 0, borderColor: c.border }}>
          <T v="title" style={{ fontSize: 22 }}>{String(it.value)}</T>
          <T v="caption" color="textMuted" style={{ marginTop: 2 }}>{it.label}</T>
        </Pressable>
      ))}
    </View>
  );
}

/** Rows grouped in one card with hairline dividers (settings lists). */
export function Group({ children }: { children: React.ReactNode }) {
  const { c } = useTheme();
  const rows = (Array.isArray(children) ? children : [children]).flat().filter(Boolean);
  return (
    <View style={[{ backgroundColor: c.surface, borderRadius: radius.card, paddingHorizontal: space.lg, paddingVertical: space.xs }, elevation(c)]}>
      {rows.map((child, i) => (
        <View key={i} style={i ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border } : undefined}>{child}</View>
      ))}
    </View>
  );
}

export function Row({ icon, title, subtitle, onPress, right, danger }: { icon?: IconName; title: string; subtitle?: string; onPress?: () => void; right?: React.ReactNode; danger?: boolean }) {
  const { c } = useTheme();
  const content = (
    <View style={styles.row}>
      {icon ? (
        <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: danger ? c.dangerSoft : c.surfaceAlt, alignItems: 'center', justifyContent: 'center', marginRight: space.md }}>
          <Ionicons name={icon} size={18} color={danger ? c.danger : c.text} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <T color={danger ? 'danger' : 'text'} style={{ fontWeight: '500' }}>{title}</T>
        {subtitle ? <T v="small" color="textMuted">{subtitle}</T> : null}
      </View>
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={c.textFaint} /> : null)}
    </View>
  );
  if (!onPress) return content;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title} accessibilityHint={subtitle} android_ripple={{ color: c.surfaceAlt }}>{content}</Pressable>;
}

export function ToggleRow({ title, subtitle, value, onChange }: { title: string; subtitle?: string; value: boolean; onChange: (v: boolean) => void }) {
  const { c } = useTheme();
  return (
    <Row
      title={title}
      subtitle={subtitle}
      right={<Switch value={value} onValueChange={onChange} accessibilityLabel={title} trackColor={{ true: c.primary, false: c.border }} thumbColor={c.surface} />}
    />
  );
}

export function Divider() {
  const { c } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: space.sm }} />;
}

export function Banner({ tone = 'info', icon, title, body, action }: { tone?: 'info' | 'warning' | 'danger' | 'accent'; icon?: IconName; title: string; body?: string; action?: React.ReactNode }) {
  const { c } = useTheme();
  const [bg, fg] = { info: [c.infoSoft, c.info], warning: [c.warningSoft, c.warning], danger: [c.dangerSoft, c.danger], accent: [c.accentSoft, c.onAccentSoft] }[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.tile, padding: space.lg, flexDirection: 'row', gap: space.md, marginVertical: space.sm }} accessibilityRole="alert">
      <Ionicons name={icon ?? (tone === 'danger' ? 'alert-circle' : tone === 'warning' ? 'warning' : 'information-circle')} size={20} color={fg} />
      <View style={{ flex: 1 }}>
        <T v="subtitle" color={fg} style={{ fontSize: 14 }}>{title}</T>
        {body ? <T v="small" color={fg} style={{ marginTop: 2 }}>{body}</T> : null}
        {action ? <View style={{ marginTop: space.sm, flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{action}</View> : null}
      </View>
    </View>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: space.xxl, paddingHorizontal: space.lg }}>
      <View style={[{ width: 64, height: 64, borderRadius: 32, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', marginBottom: space.md }, elevation(c, 'button')]}>
        <Ionicons name={icon} size={28} color={c.textMuted} />
      </View>
      <T v="subtitle" style={{ textAlign: 'center' }}>{title}</T>
      {body ? <T v="small" color="textMuted" style={{ textAlign: 'center', marginTop: 4, maxWidth: 320 }}>{body}</T> : null}
      {action ? <View style={{ marginTop: space.lg }}>{action}</View> : null}
    </View>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ padding: space.xxl, alignItems: 'center' }} accessibilityLabel={label} accessible>
      <ActivityIndicator color={c.scheme === 'dark' ? c.accent : c.text} />
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Banner tone="danger" title="Something went wrong" body={message} action={onRetry ? <Button kind="outline" title="Retry" onPress={onRetry} /> : undefined} />;
}

/** Catches a crash while rendering a screen, so one bad item shows an error instead of closing the app. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Screen>
        <ErrorState message={this.state.error.message} onRetry={() => this.setState({ error: null })} />
      </Screen>
    );
  }
}

/** Provenance badge: where a piece of content came from. */
export function Provenance({ origin }: { origin: string }) {
  const map: Record<string, [string, 'neutral' | 'accent' | 'info' | 'warning']> = {
    local: ['Extracted on device', 'neutral'],
    user: ['Your edit', 'accent'],
    model: ['AI-generated', 'warning'],
    server: ['From your server', 'info'],
    generating: ['AI summary · generating…', 'info'],
    none: ['—', 'neutral'],
  };
  const [label, tone] = map[origin] ?? [origin, 'neutral'];
  return <Chip label={label} tone={tone} icon={origin === 'model' || origin === 'generating' ? 'sparkles-outline' : origin === 'server' ? 'server-outline' : origin === 'user' ? 'create-outline' : 'phone-portrait-outline'} />;
}

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: c.overlay }} onPress={onClose} accessibilityLabel="Close" />
      <View style={{ backgroundColor: c.scheme === 'dark' ? c.surface : c.bg, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingHorizontal: space.lg, paddingBottom: space.lg, paddingTop: space.sm, maxHeight: '85%' }}>
        <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: c.border, marginBottom: space.sm }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
          <T v="title" style={{ flex: 1 }} accessibilityRole="header">{title}</T>
          <CircleButton icon="close" label="Close" onPress={onClose} size={18} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md },
  circle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  button: { minHeight: 50, borderRadius: radius.pill, paddingHorizontal: space.xl, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, borderWidth: 1, overflow: 'hidden' },
  iconBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, maxWidth: 260 },
  chipTouch: { minHeight: 40, justifyContent: 'center', marginRight: 6, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.md, minHeight: 60 },
});

/** Bottom message with an optional action (e.g. Undo). The caller decides when to hide it. */
export function Snackbar({ message, actionLabel, onAction, bottom = space.lg }: { message: string | null; actionLabel?: string; onAction?: () => void; bottom?: number }) {
  const { c } = useTheme();
  if (!message) return null;
  const bg = c.scheme === 'dark' ? c.surfaceAlt : c.primary;
  const fg = c.scheme === 'dark' ? c.text : c.onPrimary;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[{ position: 'absolute', left: space.lg, right: space.lg, bottom, flexDirection: 'row', alignItems: 'center', backgroundColor: bg, borderRadius: radius.tile, paddingLeft: space.lg, paddingRight: space.xs, minHeight: 54 }, shadow.float]}
    >
      <T color={fg} style={{ flex: 1 }} numberOfLines={2}>{message}</T>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" accessibilityLabel={actionLabel} style={{ paddingHorizontal: space.md, paddingVertical: space.sm }}>
          <T color={c.scheme === 'dark' ? c.accent : fg} style={{ fontWeight: '700' }}>{actionLabel}</T>
        </Pressable>
      ) : null}
    </View>
  );
}
