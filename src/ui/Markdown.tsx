/**
 * Markdown for chat answers and reports: headings, paragraphs, bullet and
 * numbered lists, quotes, dividers, fenced code with Copy, tables (scroll
 * sideways), bold/italic/strike/code/links, and citation pills ([S1] → a tappable
 * numbered pill when `onCite` is given).
 */

import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { type MdInline, parseInline, parseMarkdown } from '../core/markdown';
import { radius, space, type as typo, useTheme } from './theme';

function Inline({ text, color, onCite, onTime, size }: { text: string; color: string; onCite?: (sid: string) => void; onTime?: (ms: number) => void; size?: number }) {
  const { c } = useTheme();
  const base = [typo.body, { color }, size ? { fontSize: size, lineHeight: Math.round(size * 1.5) } : null];
  return (
    <Text style={base}>
      {parseInline(text).map((p: MdInline, i) => {
        switch (p.t) {
          case 'bold': return <Text key={i} style={{ fontWeight: '700' }}>{p.v}</Text>;
          case 'italic': return <Text key={i} style={{ fontStyle: 'italic' }}>{p.v}</Text>;
          case 'strike': return <Text key={i} style={{ textDecorationLine: 'line-through' }}>{p.v}</Text>;
          case 'code': return <Text key={i} style={[typo.mono, { backgroundColor: c.surfaceAlt, fontSize: (size ?? 16) - 2 }]}>{` ${p.v} `}</Text>;
          case 'link': return <Text key={i} accessibilityRole="link" style={{ color: c.accent, textDecorationLine: 'underline' }} onPress={() => void Linking.openURL(p.href)}>{p.v}</Text>;
          case 'cite': {
            const n = p.v.slice(1);
            return (
              <Text key={i} onPress={onCite ? () => onCite(p.v) : undefined} accessibilityRole={onCite ? 'link' : undefined} accessibilityLabel={`Source ${n}`}
                style={{ color: c.accent, fontSize: 12, fontWeight: '700', backgroundColor: c.accentSoft }}>{` ${n} `}</Text>
            );
          }
          case 'time':
            return (
              <Text key={i} onPress={onTime ? () => onTime(p.ms) : undefined} accessibilityRole={onTime ? 'link' : undefined} accessibilityLabel={`Play from ${p.v}`}
                style={{ color: c.accent, fontSize: 13, fontWeight: '700', backgroundColor: c.accentSoft }}>{` ▶ ${p.v.replace(/^0(\d:)/, '$1')} `}</Text>
            );
          default: return <Text key={i}>{p.v}</Text>;
        }
      })}
    </Text>
  );
}

function CodeBlock({ text, lang }: { text: string; lang: string }) {
  const { c } = useTheme();
  const [copied, setCopied] = React.useState(false);
  return (
    <View style={{ backgroundColor: c.surfaceAlt, borderRadius: radius.md, marginVertical: space.xs, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.md, paddingTop: 6 }}>
        <Text style={[typo.caption, { color: c.textFaint }]}>{lang || 'code'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy code" hitSlop={8}
          onPress={() => void Clipboard.setStringAsync(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
          <Text style={[typo.caption, { color: c.accent, fontWeight: '600' }]}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: space.md }}>
        <Text selectable style={[typo.mono, { color: c.text, fontSize: 13 }]}>{text}</Text>
      </ScrollView>
    </View>
  );
}

function Table({ header, rows, align, onCite, onTime }: { header: string[]; rows: string[][]; align: ('left' | 'center' | 'right')[]; onCite?: (sid: string) => void; onTime?: (ms: number) => void }) {
  const { c } = useTheme();
  const width = (k: number) => (header.length <= 2 ? 170 : k === 0 ? 120 : 190);
  const cell = (txt: string, k: number, head: boolean, key: string) => (
    <View key={key} style={{ width: width(k), padding: space.sm, borderRightWidth: k < header.length - 1 ? 1 : 0, borderColor: c.border }}>
      <View style={{ alignItems: align[k] === 'right' ? 'flex-end' : align[k] === 'center' ? 'center' : 'flex-start' }}>
        <Inline text={head ? `**${txt.replace(/\*\*/g, '')}**` : txt} color={c.text} onCite={onCite} onTime={onTime} size={14} />
      </View>
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={{ marginVertical: space.xs }} accessibilityLabel={`Table with ${rows.length} rows`}>
      <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: radius.md, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', backgroundColor: c.surfaceAlt }}>{header.map((h, k) => cell(h, k, true, `h${k}`))}</View>
        {rows.map((r, ri) => (
          <View key={ri} style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: c.border, backgroundColor: ri % 2 ? c.surface : 'transparent' }}>
            {r.map((v, k) => cell(v, k, false, `${ri}-${k}`))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export function Markdown({ source, onCite, onTime }: { source: string; onCite?: (sid: string) => void; onTime?: (ms: number) => void }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: space.sm }}>
      {parseMarkdown(source).map((b, i) => {
        switch (b.type) {
          case 'heading': {
            const st = b.level === 1 ? typo.title : b.level === 2 ? typo.subtitle : { ...typo.body, fontWeight: '700' as const };
            return <Text key={i} accessibilityRole="header" style={[st, { color: c.text, marginTop: i ? space.xs : 0 }]}>{b.text.replace(/\*\*/g, '')}</Text>;
          }
          case 'paragraph': return <Inline key={i} text={b.text} color={c.text} onCite={onCite} onTime={onTime} />;
          case 'quote': return <View key={i} style={{ borderLeftWidth: 3, borderColor: c.accent, paddingLeft: space.md }}><Inline text={b.text} color={c.textMuted} onCite={onCite} onTime={onTime} /></View>;
          case 'hr': return <View key={i} style={{ height: 1, backgroundColor: c.border, marginVertical: space.xs }} />;
          case 'code': return <CodeBlock key={i} text={b.text} lang={b.lang} />;
          case 'table': return <Table key={i} header={b.header} rows={b.rows} align={b.align} onCite={onCite} onTime={onTime} />;
          case 'list':
            return (
              <View key={i} style={{ gap: 4 }}>
                {b.items.map((it, k) => (
                  <View key={k} style={{ flexDirection: 'row', paddingLeft: it.indent * 16 }}>
                    <Text style={[typo.body, { color: c.textMuted, minWidth: b.ordered ? 24 : 16 }]}>{b.ordered ? it.marker : '•'}</Text>
                    <View style={{ flex: 1 }}><Inline text={it.text} color={c.text} onCite={onCite} onTime={onTime} /></View>
                  </View>
                ))}
              </View>
            );
          default: return null;
        }
      })}
    </View>
  );
}
