/** Minimal Markdown preview for Qivra reports (headings, lists, quotes, bold, code, links). */

import React from 'react';
import { Linking, Text, View } from 'react-native';
import { type as typo, space, useTheme } from './theme';

function Inline({ text, color }: { text: string; color: string }) {
  const { c } = useTheme();
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|<https?:[^>]+>)/g).filter(Boolean);
  return (
    <Text style={[typo.body, { color }]}>
      {parts.map((p, i) => {
        if (p.startsWith('**')) return <Text key={i} style={{ fontWeight: '700' }}>{p.slice(2, -2)}</Text>;
        if (p.startsWith('`')) return <Text key={i} style={[typo.mono, { backgroundColor: c.surfaceAlt }]}>{p.slice(1, -1)}</Text>;
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p) ?? (/^<(https?:[^>]+)>$/.exec(p) ? [p, p.slice(1, -1), p.slice(1, -1)] : null);
        if (link && /^https?:/.test(link[2])) {
          return <Text key={i} accessibilityRole="link" style={{ color: c.accent, textDecorationLine: 'underline' }} onPress={() => void Linking.openURL(link[2])}>{link[1]}</Text>;
        }
        return <Text key={i}>{p.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')}</Text>;
      })}
    </Text>
  );
}

export function Markdown({ source }: { source: string }) {
  const { c } = useTheme();
  return (
    <View>
      {source.split('\n').map((line, i) => {
        if (!line.trim()) return <View key={i} style={{ height: space.sm }} />;
        const h = /^(#{1,3})\s+(.*)$/.exec(line);
        if (h) {
          const st = h[1].length === 1 ? typo.display : h[1].length === 2 ? typo.title : typo.subtitle;
          return <Text key={i} accessibilityRole="header" style={[st, { color: c.text, marginTop: h[1].length === 1 ? 0 : space.md }]}>{h[2]}</Text>;
        }
        if (line.startsWith('> ')) return <View key={i} style={{ borderLeftWidth: 3, borderColor: c.accent, paddingLeft: space.sm }}><Inline text={line.slice(2)} color={c.textMuted} /></View>;
        const li = /^(\s*)[-*]\s+(.*)$/.exec(line) ?? /^(\s*)\d+\.\s+(.*)$/.exec(line);
        if (li) {
          return (
            <View key={i} style={{ flexDirection: 'row', paddingLeft: li[1].length * 8, marginVertical: 1 }}>
              <Text style={[typo.body, { color: c.textMuted, width: 16 }]}>•</Text>
              <View style={{ flex: 1 }}><Inline text={li[2]} color={c.text} /></View>
            </View>
          );
        }
        return <Inline key={i} text={line} color={c.text} />;
      })}
    </View>
  );
}
