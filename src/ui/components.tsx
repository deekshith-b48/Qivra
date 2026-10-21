/** Qivra UI kit: small, accessible building blocks on top of the theme tokens. */

import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View,
  type PressableProps, type StyleProp, type TextInputProps, type TextProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { radius, space, type, useTheme, type Palette } from './theme';

export type IconName = keyof typeof Ionicons.glyphMap;

type TextVariant = keyof typeof type;
export function T({ v = 'body', color, style, children, ...rest }: Omit<TextProps, 'style'> & { v?: TextVariant; color?: keyof Palette | string; style?: StyleProp<TextStyle>; children: React.ReactNode }) {
  const { c } = useTheme();
  const col = color ? ((c as unknown as Record<string, string>)[color] ?? color) : c.text;
  return <Text style={[type[v], { color: col }, style]} {...rest}>{children}</Text>;
}

export function Screen({ children, scroll = true, padded = true, edges = ['top'] as ('top' | 'bottom')[] }: { children: React.ReactNode; scroll?: boolean; padded?: boolean; edges?: ('top' | 'bottom')[] }) {
  const { c } = useTheme();
  const inner = padded ? { paddingHorizontal: space.lg, paddingBottom: space.xxl } : undefined;
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: c.bg }}>
      {scroll ? <ScrollView contentContainerStyle={inner} keyboardShouldPersistTaps="handled">{children}</ScrollView> : <View style={[{ flex: 1 }, inner]}>{children}</View>}
    </SafeAreaView>
  );
}

export function Header({ title, subtitle, onBack, actions }: { title: string; subtitle?: string; onBack?: () => void; actions?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      {onBack ? <IconButton icon="arrow-back" label="Back" onPress={onBack} /> : null}
      <View style={{ flex: 1, paddingLeft: onBack ? space.xs : 0 }}>
        <T v="title" accessibilityRole="header" numberOfLines={2}>{title}</T>
        {subtitle ? <T v="small" color="textMuted" numberOfLines={2}>{subtitle}</T> : null}
      </View>
      {actions ? <View style={{ flexDirection: 'row' }}>{actions}</View> : null}
    </View>
  );
}

export function Wordmark({ size = 22 }: { size?: number }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }} accessible accessibilityLabel="Qivra">
      <View style={{ width: size * 0.9, height: size * 0.9, borderRadius: size, borderWidth: size * 0.16, borderColor: c.text, marginRight: 8, alignItems: 'flex-end', justifyContent: 'flex-end' }}>
        <View style={{ width: size * 0.3, height: size * 0.3, backgroundColor: c.accent, borderRadius: 2, transform: [{ translateX: size * 0.12 }, { translateY: size * 0.12 }] }} />
      </View>
      <Text style={{ fontSize: size, fontWeight: '700', letterSpacing: -0.5, color: c.text }}>qivra</Text>
    </View>
  );
}

export function Card({ children, style, onPress, label }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; label?: string }) {
  const { c } = useTheme();
  const base = [{ backgroundColor: c.surface, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.lg }, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} android_ripple={{ color: c.surfaceAlt }} style={({ pressed }) => [base, pressed && { opacity: 0.85 }]}>
      {children}
    </Pressable>
  );
}

type ButtonKind = 'filled' | 'tonal' | 'outline' | 'text' | 'danger';
export function Button({ title, onPress, kind = 'filled', icon, disabled, loading, style, accessibilityHint }: { title: string; onPress: () => void; kind?: ButtonKind; icon?: IconName; disabled?: boolean; loading?: boolean; style?: StyleProp<ViewStyle>; accessibilityHint?: string }) {
  const { c } = useTheme();
  const bg = { filled: c.primary, tonal: c.accentSoft, outline: 'transparent', text: 'transparent', danger: c.dangerSoft }[kind];
  const fg = { filled: c.onPrimary, tonal: c.onAccentSoft, outline: c.text, text: c.text, danger: c.danger }[kind];
  const off = disabled || loading;
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
        { backgroundColor: bg, borderColor: kind === 'outline' ? c.border : 'transparent', opacity: off ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} size="small" /> : icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
      <Text style={[type.subtitle, { color: fg, fontSize: 15 }]}>{title}</Text>
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
    neutral: [c.surfaceAlt, c.text], accent: [c.accentSoft, c.onAccentSoft], warning: [c.warningSoft, c.warning], danger: [c.dangerSoft, c.danger], info: [c.infoSoft, c.info],
  } as const;
  const [bg, fg] = selected ? [c.primary, c.onPrimary] : tones[tone];
  const body = (
    <View style={[styles.chip, { backgroundColor: bg }]}>
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
      <T v="caption" color="textMuted" style={{ marginBottom: 4 }}>{label}</T>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={c.textFaint}
        {...props}
        style={[type.body, { color: c.text, backgroundColor: c.surface, borderColor: error ? c.danger : c.border, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 10, minHeight: 48, textAlignVertical: props.multiline ? 'top' : 'center' }]}
      />
      {error ? <T v="small" color="danger" style={{ marginTop: 4 }}>{error}</T> : help ? <T v="small" color="textFaint" style={{ marginTop: 4 }}>{help}</T> : null}
    </View>
  );
}

export function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: space.xl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
        <T v="subtitle" style={{ flex: 1 }} accessibilityRole="header">{title}</T>
        {action}
      </View>
      {children}
    </View>
  );
}

export function Row({ icon, title, subtitle, onPress, right, danger }: { icon?: IconName; title: string; subtitle?: string; onPress?: () => void; right?: React.ReactNode; danger?: boolean }) {
  const { c } = useTheme();
  const content = (
    <View style={styles.row}>
      {icon ? <Ionicons name={icon} size={20} color={danger ? c.danger : c.textMuted} style={{ marginRight: space.md }} /> : null}
      <View style={{ flex: 1 }}>
        <T color={danger ? 'danger' : 'text'}>{title}</T>
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
      right={<Switch value={value} onValueChange={onChange} accessibilityLabel={title} trackColor={{ true: c.accent, false: c.border }} thumbColor={c.bg} />}
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
    <View style={{ backgroundColor: bg, borderRadius: radius.md, padding: space.md, flexDirection: 'row', gap: space.sm, marginVertical: space.sm }} accessibilityRole="alert">
      <Ionicons name={icon ?? (tone === 'danger' ? 'alert-circle' : tone === 'warning' ? 'warning' : 'information-circle')} size={20} color={fg} />
      <View style={{ flex: 1 }}>
        <T v="subtitle" color={fg} style={{ fontSize: 14 }}>{title}</T>
        {body ? <T v="small" color={fg}>{body}</T> : null}
        {action ? <View style={{ marginTop: space.sm, flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{action}</View> : null}
      </View>
    </View>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: space.xxl, paddingHorizontal: space.lg }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', marginBottom: space.md }}>
        <Ionicons name={icon} size={26} color={c.textMuted} />
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
      <ActivityIndicator color={c.text} />
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Banner tone="danger" title="Something went wrong" body={message} action={onRetry ? <Button kind="outline" title="Retry" onPress={onRetry} /> : undefined} />;
}

/** Provenance badge: where a piece of content came from. */
export function Provenance({ origin }: { origin: string }) {
  const map: Record<string, [string, 'neutral' | 'accent' | 'info' | 'warning']> = {
    local: ['Extracted on device', 'neutral'],
    user: ['Your edit', 'accent'],
    model: ['AI-generated', 'warning'],
    server: ['From your server', 'info'],
    none: ['—', 'neutral'],
  };
  const [label, tone] = map[origin] ?? [origin, 'neutral'];
  return <Chip label={label} tone={tone} icon={origin === 'model' ? 'sparkles-outline' : origin === 'server' ? 'server-outline' : origin === 'user' ? 'create-outline' : 'phone-portrait-outline'} />;
}

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: c.overlay }} onPress={onClose} accessibilityLabel="Close" />
      <View style={{ backgroundColor: c.bg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, maxHeight: '85%' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
          <T v="title" style={{ flex: 1 }} accessibilityRole="header">{title}</T>
          <IconButton icon="close" label="Close" onPress={onClose} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </View>
    </Modal>
  );
}

export function Fab({ label, icon, onPress }: { label: string; icon: IconName; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.fab, { backgroundColor: c.primary, opacity: pressed ? 0.85 : 1 }]}
    >
      <Ionicons name={icon} size={20} color={c.onPrimary} />
      <Text style={[type.subtitle, { color: c.onPrimary, fontSize: 15 }]}>{label}</Text>
    </Pressable>
  );
}

export function Pressy(props: PressableProps & { children: React.ReactNode }) {
  return <Pressable {...props} />;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm, minHeight: 56 },
  button: { minHeight: 48, borderRadius: radius.pill, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, borderWidth: 1 },
  iconBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill, maxWidth: 260 },
  chipTouch: { minHeight: 40, justifyContent: 'center', marginRight: 6, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.md, minHeight: 56 },
  fab: { position: 'absolute', right: space.lg, bottom: space.lg, minHeight: 52, borderRadius: radius.pill, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center', gap: space.sm, elevation: 4 },
});
